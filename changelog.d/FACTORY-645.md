bump: minor

### Fixed
- The watcher no longer misses a plain channel post when the server's `Unread_Count` setting is
  mentions-only: activity is now detected with `rooms.get?updatedSince` (a room's own `_updatedAt`
  moves on every post) instead of relying on each subscription's own `_updatedAt`, which that
  server setting can leave untouched for a non-mention message.

### Added
- `/api/snapshot` now reports `rooms: {tracked, unsyncedActive}` per session, naming any room at
  notification level `all` whose detected activity hasn't been matched by a message sync yet.
