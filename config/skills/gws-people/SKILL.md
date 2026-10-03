---
name: gws-people
description: "Google People: Search, create, update, and manage contacts and profiles."
metadata:
  version: "0.22.5"
  openclaw: "category=productivity;requires=bins:gws"
  cliHelp: "gws people --help"
---

# people (v1)

> **PREREQUISITE:** Read `../gws-shared/SKILL.md` for auth, global flags, and security rules. If missing, stop and report `AGENT_GOOGLE_WORKSPACE_SKILL_PACKAGE_INVALID`; never generate skills at runtime.

```bash
gws people <resource> <method> [flags]
```

## Osinara Contact Policy

- Use only the currently mounted Osinara Google profile; never switch credentials or inspect credential files.
- Contact lookup is read-only; every create, update, delete, and batch operation
  receives mandatory human approval from `execute_google_workspace`.
- Batch operations include `batchCreateContacts`, `batchUpdateContacts`, `batchDeleteContacts`, and contact-group member batch changes.
- Before `updateContact`, read the latest contact and include `metadata.sources.etag` so Google can reject stale writes safely.
- Send mutate requests for the same user sequentially; do not run concurrent contact writes against the same account.
- If Google reports insufficient People API scopes, follow the shared connection guide and ask the user to reconnect Google Workspace.

## Common Contact Commands

```bash
# Warm up contact search cache, then search saved contacts.
gws people people searchContacts --params '{"query":"","readMask":"names,emailAddresses,phoneNumbers,organizations","pageSize":10}'
gws people people searchContacts --params '{"query":"Dina","readMask":"names,emailAddresses,phoneNumbers,organizations","pageSize":10}'

# Search auto-saved Other Contacts from prior interactions.
gws people otherContacts search --params '{"query":"Dina","readMask":"names,emailAddresses,phoneNumbers","pageSize":10}'

# Search Google Workspace domain directory when the profile has directory access.
gws people people searchDirectoryPeople --params '{"query":"Dina","readMask":"names,emailAddresses,phoneNumbers,organizations","sources":["DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE","DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT"],"pageSize":10}'

# Create a saved contact; execute_google_workspace supplies mandatory human approval.
gws people people createContact \
  --params '{"personFields":"names,emailAddresses,phoneNumbers"}' \
  --json '{"names":[{"givenName":"Dina","familyName":"Fomina"}],"emailAddresses":[{"value":"dina@example.com"}]}'
```

## API Resources

### contactGroups

- `batchGet` - Get contact groups owned by the authenticated user.
- `create` - Create a contact group.
- `delete` - Delete a contact group through mandatory human approval.
- `get` - Get a contact group.
- `list` - List contact groups.
- `update` - Rename a contact group.
- `members` - Operations on contact-group members.

### otherContacts

- `copyOtherContactToMyContactsGroup` - Copy an Other Contact to saved contacts.
- `list` - List auto-saved Other Contacts.
- `search` - Search Other Contacts by name, email, or phone number.

### people

- `batchCreateContacts` - Create contacts in a batch through mandatory human approval.
- `batchDeleteContacts` - Delete contacts in a batch through mandatory human approval.
- `batchUpdateContacts` - Update contacts in a batch through mandatory human approval.
- `createContact` - Create a contact through mandatory human approval.
- `deleteContact` - Delete a contact through mandatory human approval.
- `deleteContactPhoto` - Delete a contact photo through mandatory human approval.
- `get` - Read a person by resource name, including `people/me`.
- `getBatchGet` - Read specific people by resource name.
- `listDirectoryPeople` - List Google Workspace domain profiles and domain contacts.
- `searchContacts` - Search saved contacts by name, nickname, email, phone, or organization.
- `searchDirectoryPeople` - Search Google Workspace domain profiles and contacts.
- `updateContact` - Update a contact through mandatory human approval; requires current `metadata.sources.etag`.
- `updateContactPhoto` - Update a contact photo through mandatory human approval.
- `connections` - Operations on authenticated-user connections.

## Discovering Commands

Before calling any API method, inspect it:

```bash
# Browse resources and methods
gws people --help

# Inspect a method's required params, types, and defaults
gws schema people.<resource>.<method>
```

Use `gws schema` output to build your `--params` and `--json` flags.
