# Bookfish novel runtime

Distribution assets for the Bookfish novel engine (Windows x64).

## Runtime

- File: `bookfish-novel-runtime-1.12.0-bf1-win32-x64.zip`
- Size: 85,784,286 bytes
- SHA-256: `b9f16f858150a8370fb59a2c4df582b99f133b2b60419434c579d7485060b71e`
- Platform: Windows x64
- Engine: so-novel 1.12.0 (AGPL-3.0), Temurin 21.0.8+9-LTS
- Unpacked: 189,431,419 bytes in 323 files

Download the release asset; do not unpack by hand. The Bookfish extension verifies the archive digest, extracts it safely, starts the bundled Java and bridge, then activates it atomically.

## Licenses

The runtime bundles the unmodified so-novel engine and Eclipse Temurin JRE; see the license files inside the ZIP. Bookfish extension code is MIT. The bridge/AGPL distribution boundary is documented in the project acceptance report.