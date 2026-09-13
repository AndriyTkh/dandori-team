// Runs before tests/setup.ts, so before Dexie is first imported.
//
// Node ships a global `BroadcastChannel`; jsdom does not, so under vitest's
// jsdom environment Dexie (dexie.js ~6496) finds Node's and uses it to
// announce its own mutations. Node's channel then dispatches a Node-realm
// `MessageEvent` through a `dispatchEvent` that checks it against jsdom's
// `Event`, and every announcement is an unhandled
// "The 'event' argument must be an instance of Event" error — 13 of them per
// full run, exit 1, while all 29 tests pass. Nothing under test needs
// cross-tab notification, so the global is removed and Dexie takes its
// no-channel path, exactly as it would in a browser without the API.
delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel
