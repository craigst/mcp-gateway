# Version 0.15.0

## Changes
- Refresh the console navigation, dashboard and light/dark appearance.
- Add explicit tool selection for new API keys and controls for changing individual tool grants.
- Remove the agents/delegate RPC method and replace the delegation screen with the existing approvals queue.
- Fix existing lint errors.

## Upgrade notes
Existing keys and saved settings are preserved. New keys use explicit tool grants; existing wildcard grants retain their previous behavior. The optional client tool limit is checked when creating a key, not enforced permanently. Delegation calls now return method not found. Back up the gateway before updating.

The built-in knowledge base, personal social-message integrations, cross-platform device installers and complete removal of delegation compatibility code are not included in this version.
