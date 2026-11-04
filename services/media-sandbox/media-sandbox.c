/*
 * media-sandbox: runs one media tool (FFmpeg, ffprobe) on a file a chat participant sent, with no
 * way to reach anything but its input and output.
 *
 * Usage: media-sandbox PROGRAM [ARGUMENT...]
 *   PROGRAM is an absolute path or a name looked up in PATH.
 *
 * The agent hands the tool its input as an open descriptor and reads its output from a pipe, so the
 * tool needs no file and no network of its own. A decoder is where a crafted file attacks; a
 * decoder taken over must not read the families' files in the agent's container or reach its
 * networks (the sandbox runner's control network among them). Before the tool starts, this program:
 *
 * - sets no_new_privs, so neither restriction can be shed by a set-user-ID program;
 * - restricts itself with Landlock: no file access at all, except reading and executing the tool
 *   and the system libraries the dynamic loader maps (/lib, /lib64, /usr/lib, /etc/ld.so.cache);
 *   no TCP bind or connect (Landlock ABI 4 and later); no abstract UNIX socket or signal outside
 *   its own domain (ABI 6 and later). Already open descriptors stay usable: Landlock checks paths;
 * - installs a seccomp filter that refuses with EACCES: socket(2), socketpair(2) and io_uring (which
 *   can create sockets without socket(2)), so no network of any kind is reachable even where
 *   Landlock has no network rights; a socket ioctl (type 0x89): the tool's standard output and error
 *   are the agent's socketpair, which would otherwise list the container's interfaces; a new process
 *   (fork, vfork, clone without CLONE_THREAD; clone3 answers ENOSYS, so the C library falls back to
 *   clone for threads): a child kept alive would hold the output open and the agent would wait for
 *   it; and what Docker's own profile already refuses, so the sandbox does not rest on it alone:
 *   namespaces, mounts, keyrings, userfaultfd, bpf, perf, ptrace and other processes' memory;
 * - forbids core dumps.
 *
 * Landlock missing (kernel without it, or a seccomp profile that hides it) is a refusal, never a run
 * without the restriction: the agent then sees the tool fail and goes on without a frame.
 *
 * Exit codes: the tool's own, or 120 when a restriction cannot be applied, 125 for a usage error,
 * 126 when the tool exists but cannot be started, 127 when it does not exist. A failure of this
 * program itself is one line `media-sandbox: STEP: MESSAGE (ERRNO_NAME)` on descriptor 4 when the
 * caller opened it, else on stderr. Descriptor 4 is closed on exec, so the tool can never write a
 * line there and pass its own failure for the sandbox's.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <linux/sched.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <unistd.h>

/* The Landlock UAPI (linux/landlock.h), written out: the build image's headers predate ABI 4. */
#define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)
#define LANDLOCK_RULE_PATH_BENEATH 1
#define FS_EXECUTE (1ULL << 0)
#define FS_READ_FILE (1ULL << 2)
#define FS_READ_DIR (1ULL << 3)
/* Every filesystem right of ABI 1 (bits 0-12); ABI 2 adds REFER, 3 TRUNCATE, 5 IOCTL_DEV. */
#define FS_ABI1_ALL ((1ULL << 13) - 1)
#define FS_REFER (1ULL << 13)
#define FS_TRUNCATE (1ULL << 14)
#define FS_IOCTL_DEV (1ULL << 15)
#define NET_BIND_TCP (1ULL << 0)
#define NET_CONNECT_TCP (1ULL << 1)
#define SCOPE_ABSTRACT_UNIX_SOCKET (1ULL << 0)
#define SCOPE_SIGNAL (1ULL << 1)

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#define __NR_landlock_add_rule 445
#define __NR_landlock_restrict_self 446
#endif

#if defined(__x86_64__)
#define AUDIT_ARCH_CURRENT AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define AUDIT_ARCH_CURRENT AUDIT_ARCH_AARCH64
#else
#error "media-sandbox knows the system calls of x86_64 and aarch64 only"
#endif

#define STATUS_FD 4
#define EXIT_RESTRICTION 120
#define EXIT_USAGE 125
#define EXIT_NOT_STARTED 126
#define EXIT_NOT_FOUND 127

struct ruleset_attr {
  uint64_t handled_access_fs;
  uint64_t handled_access_net;
  uint64_t scoped;
};

struct path_beneath_attr {
  uint64_t allowed_access;
  int32_t parent_fd;
} __attribute__((packed));

/* What the dynamic loader of a Debian image reads and maps for a dynamically linked tool. */
static const char *const LIBRARY_DIRECTORIES[] = {"/lib", "/lib64", "/usr/lib"};
static const char *const LIBRARY_FILES[] = {"/etc/ld.so.cache"};

static int status_fd_open = 0;

static void fail(const char *step, int code) {
  int failure = errno;
  const char *name = strerrorname_np(failure);
  dprintf(status_fd_open ? STATUS_FD : STDERR_FILENO, "media-sandbox: %s: %s (%s)\n", step, strerror(failure),
          name == NULL ? "UNKNOWN" : name);
  exit(code);
}

static int allow_path(int ruleset, const char *path, uint64_t access, uint64_t handled) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) return errno == ENOENT ? 0 : -1;
  struct path_beneath_attr rule = {.allowed_access = access & handled, .parent_fd = fd};
  long added = syscall(__NR_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0);
  int saved = errno;
  close(fd);
  errno = saved;
  return added == 0 ? 0 : -1;
}

static void restrict_with_landlock(const char *program) {
  long abi = syscall(__NR_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 1) fail("Landlock is unavailable", EXIT_RESTRICTION);
  uint64_t fs = FS_ABI1_ALL;
  if (abi >= 2) fs |= FS_REFER;
  if (abi >= 3) fs |= FS_TRUNCATE;
  if (abi >= 5) fs |= FS_IOCTL_DEV;
  struct ruleset_attr attr = {
    .handled_access_fs = fs,
    .handled_access_net = abi >= 4 ? NET_BIND_TCP | NET_CONNECT_TCP : 0,
    .scoped = abi >= 6 ? SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL : 0,
  };
  int ruleset = (int)syscall(__NR_landlock_create_ruleset, &attr, sizeof(attr), 0);
  if (ruleset < 0) fail("creating the Landlock ruleset", EXIT_RESTRICTION);
  for (size_t i = 0; i < sizeof(LIBRARY_DIRECTORIES) / sizeof(*LIBRARY_DIRECTORIES); i++) {
    if (allow_path(ruleset, LIBRARY_DIRECTORIES[i], FS_EXECUTE | FS_READ_FILE | FS_READ_DIR, fs) != 0) {
      fail(LIBRARY_DIRECTORIES[i], EXIT_RESTRICTION);
    }
  }
  for (size_t i = 0; i < sizeof(LIBRARY_FILES) / sizeof(*LIBRARY_FILES); i++) {
    if (allow_path(ruleset, LIBRARY_FILES[i], FS_READ_FILE, fs) != 0) fail(LIBRARY_FILES[i], EXIT_RESTRICTION);
  }
  if (allow_path(ruleset, program, FS_EXECUTE | FS_READ_FILE, fs) != 0) fail(program, EXIT_RESTRICTION);
  if (syscall(__NR_landlock_restrict_self, ruleset, 0) != 0) fail("enforcing the Landlock ruleset", EXIT_RESTRICTION);
  close(ruleset);
}

#define RETURN_ERRNO(value) BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ((value) & SECCOMP_RET_DATA))
#define REFUSE(nr) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (nr), 0, 1), RETURN_ERRNO(EACCES)
#define LOW_ARG(index) offsetof(struct seccomp_data, args[index])
/* Socket ioctls are numbered 0x89XX (SIOCGIFCONF, SIOCGIFADDR, ...). */
#define SOCKET_IOCTL_TYPE 0x8900
#define IOCTL_TYPE_MASK 0xff00

static void refuse_reaching_out(void) {
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_CURRENT, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
    /* The x32 numbering would reach the same calls under other numbers. */
    BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
#endif
    REFUSE(__NR_socket),
    REFUSE(__NR_socketpair),
    REFUSE(__NR_io_uring_setup),
    REFUSE(__NR_io_uring_enter),
    REFUSE(__NR_io_uring_register),
#ifdef __NR_fork
    REFUSE(__NR_fork),
#endif
#ifdef __NR_vfork
    REFUSE(__NR_vfork),
#endif
    REFUSE(__NR_unshare),
    REFUSE(__NR_setns),
    REFUSE(__NR_mount),
    REFUSE(__NR_umount2),
    REFUSE(__NR_pivot_root),
    REFUSE(__NR_open_tree),
    REFUSE(__NR_move_mount),
    REFUSE(__NR_fsopen),
    REFUSE(__NR_fsconfig),
    REFUSE(__NR_fsmount),
    REFUSE(__NR_fspick),
    REFUSE(__NR_keyctl),
    REFUSE(__NR_add_key),
    REFUSE(__NR_request_key),
    REFUSE(__NR_userfaultfd),
    REFUSE(__NR_bpf),
    REFUSE(__NR_perf_event_open),
    REFUSE(__NR_ptrace),
    REFUSE(__NR_process_vm_readv),
    REFUSE(__NR_process_vm_writev),
    REFUSE(__NR_pidfd_getfd),
    /* clone3 passes its flags in memory the filter cannot read: ENOSYS sends glibc to clone. */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone3, 0, 1),
    RETURN_ERRNO(ENOSYS),
    /* clone: a thread (CLONE_THREAD in the flags, its first argument) runs; a process does not. */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, LOW_ARG(0)),
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, CLONE_THREAD, 1, 0),
    RETURN_ERRNO(EACCES),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    /* ioctl: a socket request (its second argument) is refused. */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_ioctl, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, LOW_ARG(1)),
    BPF_STMT(BPF_ALU | BPF_AND | BPF_K, IOCTL_TYPE_MASK),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SOCKET_IOCTL_TYPE, 0, 1),
    RETURN_ERRNO(EACCES),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = {.len = (unsigned short)(sizeof(filter) / sizeof(*filter)), .filter = filter};
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) != 0) fail("installing the seccomp filter", EXIT_RESTRICTION);
}

static void forbid_core_dumps(void) {
  struct rlimit none = {.rlim_cur = 0, .rlim_max = 0};
  if (setrlimit(RLIMIT_CORE, &none) != 0) fail("forbidding core dumps", EXIT_RESTRICTION);
}

/* The absolute path of PROGRAM, looked up in PATH when it has no slash; NULL when not found. */
static char *resolve(const char *program) {
  if (strchr(program, '/') != NULL) return program[0] == '/' ? strdup(program) : NULL;
  const char *path = getenv("PATH");
  if (path == NULL) return NULL;
  char *entries = strdup(path);
  if (entries == NULL) return NULL;
  char *found = NULL;
  for (char *save = NULL, *dir = strtok_r(entries, ":", &save); dir != NULL; dir = strtok_r(NULL, ":", &save)) {
    if (dir[0] != '/') continue;
    char *candidate = NULL;
    if (asprintf(&candidate, "%s/%s", dir, program) < 0) break;
    if (access(candidate, X_OK) == 0) {
      found = candidate;
      break;
    }
    free(candidate);
  }
  free(entries);
  return found;
}

int main(int argc, char **argv) {
  /* The status descriptor stays this program's: closed on exec, the tool never holds it. */
  if (fcntl(STATUS_FD, F_SETFD, FD_CLOEXEC) == 0) status_fd_open = 1;
  if (argc < 2) {
    fprintf(stderr, "usage: media-sandbox PROGRAM [ARGUMENT...]\n");
    return EXIT_USAGE;
  }
  char *program = resolve(argv[1]);
  if (program == NULL) {
    errno = ENOENT;
    fail(argv[1], EXIT_NOT_FOUND);
  }
  if (access(program, F_OK) != 0) fail(program, errno == ENOENT ? EXIT_NOT_FOUND : EXIT_NOT_STARTED);
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) fail("setting no_new_privs", EXIT_RESTRICTION);
  forbid_core_dumps();
  restrict_with_landlock(program);
  refuse_reaching_out();
  execv(program, &argv[1]);
  fail(program, errno == ENOENT ? EXIT_NOT_FOUND : EXIT_NOT_STARTED);
  return EXIT_NOT_STARTED;
}
