# Project Summary

This bot now has three main improvements:

1. **Separate role sheets**
   - Guests are stored in two tabs inside the same Google Sheet:
     - `KhachMoi`
     - `ChuyenGia`
   - Each tab is created automatically if it does not exist.

2. **Batch link import**
   - The bot can now accept multiple Facebook links in one message.
   - If more than one valid link is detected, it groups them into a temporary batch and keeps the same 3-action flow as the single-link case.
   - The batch expires after a short time to avoid stale imports.

3. **More stable Facebook ID parsing**
   - Only Facebook or FB URLs are accepted.
   - URLs are normalized before identity extraction.
   - Stable IDs are derived using canonical patterns like:
     - `profile:id:...`
     - `profile:fbid:...`
     - `profile:username:...`
     - `share:...`

## User-input protections added

- Sticker / emoji-only messages are rejected.
- Non-Facebook URLs are rejected.
- Multiple URLs in one message are deduplicated.
- Webhook retry duplicates are ignored using message ID caching.
- Quick reply payloads are encoded to reduce parsing issues with special characters.
- Legacy action payloads are still supported.
- The role-selection step now also has a `skip` option.

## Files updated

- `index.js`
- `repositories/sheetRepository.js`
- `utils/linkParser.js`

## Validation

- Syntax check passed for all edited JavaScript files.
- Parser behavior was spot-checked with sample Facebook and non-Facebook URLs.
