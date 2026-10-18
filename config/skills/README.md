# Installed Skills

Each reviewed skill is one directory containing SKILL.md and its supporting files.
The application discovers this catalog once, then exposes all installed skills in private/family
conversations and only the persisted owner-approved selection in external groups.
The family's own skills live in the database (`agent/lib/family-skills/`) and the service
`skill-manager` in `config/service-skills/`. A skill that is not granted to a chat is neither listed to
the model nor copied into its sandbox; a granted skill's files reach the sandbox only when the model
loads it.
