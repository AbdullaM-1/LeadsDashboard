# Complete File List

This document lists all files included in the RingCentral WebPhone library package.

## Source Files (13 TypeScript files)

All files are located in `src/` directory:

1. **index.ts** - Main WebPhone class export and configuration
2. **userAgent.ts** - UserAgent management and invite functionality
3. **userAgentCore.ts** - Core user agent functionality
4. **session.ts** - Call session management (hold, mute, transfer, DTMF, recording, etc.)
5. **transport.ts** - WebSocket transport layer with reconnection logic
6. **sessionDescriptionHandler.ts** - WebRTC SDP handling and peer connection management
7. **audioHelper.ts** - Audio feedback helper for ringtones
8. **events.ts** - Event definitions and constants
9. **constants.ts** - Constants, messages, and default configurations
10. **utils.ts** - Utility functions (uuid, extend, etc.)
11. **qos.ts** - Quality of service monitoring and statistics
12. **rtpReport.ts** - RTP statistics reporting
13. **api.ts** - API utilities

## Audio Files (2 files)

Located in `assets/audio/` directory:

1. **incoming.ogg** - Audio file played for incoming calls
2. **outgoing.ogg** - Audio file played for outgoing calls

## Configuration Files

1. **tsconfig.json** - TypeScript compiler configuration
2. **package.json** - Dependencies reference (for documentation)

## Documentation Files

1. **README.md** - Complete usage guide with examples
2. **INSTALLATION.md** - Step-by-step installation instructions
3. **FILES_LIST.md** - This file

## Total File Count

- **13** TypeScript source files
- **2** Audio files
- **2** Configuration files
- **3** Documentation files
- **Total: 20 files**

## Dependencies Required

When using this library in your project, install:

```bash
npm install sip.js@^0.21.2 @ringcentral/sdk@^5.0.1
```

## File Size Summary

- Source code: ~50-60 KB (all .ts files combined)
- Audio files: ~10-20 KB each
- Total package size: ~100-150 KB

