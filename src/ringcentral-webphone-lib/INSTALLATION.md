# Installation Guide

## Quick Start

### Step 1: Copy Files to Your Next.js/React Project

Copy the contents of this folder to your project:

**Option A: Copy entire folder structure**
```
Copy ringcentral-webphone-lib/src/* → your-project/src/lib/ringcentral-webphone/
Copy ringcentral-webphone-lib/assets/audio/* → your-project/public/audio/
Copy ringcentral-webphone-lib/tsconfig.json → your-project/ (merge with existing)
```

**Option B: Copy files individually**
- Copy all `.ts` files from `src/` to your project's lib folder
- Copy `.ogg` files from `assets/audio/` to your `public/audio/` folder

### Step 2: Install Dependencies

```bash
npm install sip.js@^0.21.2 @ringcentral/sdk@^5.0.1
# or
yarn add sip.js@^0.21.2 @ringcentral/sdk@^5.0.1
```

### Step 3: Update TypeScript Configuration

If using TypeScript, ensure your `tsconfig.json` includes:

```json
{
  "compilerOptions": {
    "moduleResolution": "node",
    "esModuleInterop": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"]
}
```

### Step 4: Create Video Elements

Add hidden video elements to your layout or component:

```tsx
<video id="remoteVideo" ref={remoteVideoRef} hidden />
<video id="localVideo" ref={localVideoRef} hidden muted />
```

### Step 5: Initialize WebPhone

See `README.md` for complete usage examples.

## File Checklist

✅ **Source Files (12 files)**
- [x] index.ts
- [x] userAgent.ts
- [x] userAgentCore.ts
- [x] session.ts
- [x] transport.ts
- [x] sessionDescriptionHandler.ts
- [x] audioHelper.ts
- [x] events.ts
- [x] constants.ts
- [x] utils.ts
- [x] qos.ts
- [x] rtpReport.ts
- [x] api.ts

✅ **Audio Files (2 files)**
- [x] incoming.ogg
- [x] outgoing.ogg

✅ **Configuration**
- [x] tsconfig.json
- [x] package.json (for reference)

## Common Issues

### Import Errors
- Ensure all files are in the same directory structure
- Check that TypeScript paths are configured correctly
- Verify `sip.js` and `@ringcentral/sdk` are installed

### Audio Not Playing
- Ensure audio files are in `public/audio/` folder (Next.js) or accessible path
- Check browser console for 404 errors on audio files
- Verify audio file paths in WebPhone configuration

### TypeScript Errors
- Ensure `tsconfig.json` has proper module resolution
- Check that all type definitions from `sip.js` are available
- May need to install `@types/node` if using Node types

## Next Steps

1. Read `README.md` for detailed usage examples
2. Set up RingCentral credentials
3. Create your React components/hooks
4. Test with a simple call

