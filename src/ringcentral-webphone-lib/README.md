# RingCentral WebPhone Library

Portable library extracted from ringcentral-web-phone for use in Next.js/React applications.

## Files Included

### Source Files (`src/`)
- `index.ts` - Main WebPhone class export
- `userAgent.ts` - UserAgent management
- `userAgentCore.ts` - Core user agent functionality
- `session.ts` - Call session management (hold, mute, transfer, etc.)
- `transport.ts` - WebSocket transport layer
- `sessionDescriptionHandler.ts` - WebRTC SDP handling
- `audioHelper.ts` - Audio feedback (ringtones)
- `events.ts` - Event definitions
- `constants.ts` - Constants and configuration
- `utils.ts` - Utility functions
- `qos.ts` - Quality of service monitoring
- `rtpReport.ts` - RTP statistics
- `api.ts` - API utilities

### Audio Files (`assets/audio/`)
- `incoming.ogg` - Incoming call ringtone
- `outgoing.ogg` - Outgoing call ringtone

### Configuration
- `tsconfig.json` - TypeScript configuration

## Installation in Your Next.js/React App

### 1. Copy Files to Your Project

Copy the entire `ringcentral-webphone-lib` folder to your project, or copy its contents:

```
your-nextjs-app/
├── src/
│   ├── lib/
│   │   └── ringcentral-webphone/    # Copy src/ folder here
│   │       ├── index.ts
│   │       ├── userAgent.ts
│   │       └── ... (all other files)
│   └── ...
├── public/
│   └── audio/                        # Copy assets/audio/ here
│       ├── incoming.ogg
│       └── outgoing.ogg
└── package.json
```

### 2. Install Dependencies

```bash
npm install sip.js@^0.21.2 @ringcentral/sdk@^5.0.1
```

### 3. Update tsconfig.json (if using TypeScript)

Ensure your `tsconfig.json` includes the lib folder:

```json
{
  "compilerOptions": {
    "moduleResolution": "node",
    "esModuleInterop": true
  },
  "include": ["src/**/*"]
}
```

## Usage Example

### React Component

```typescript
'use client'; // For Next.js 13+ App Router

import { useEffect, useRef, useState } from 'react';
import WebPhone from '@/src/lib/ringcentral-webphone';
import { SDK } from '@ringcentral/sdk';

export default function CallInterface() {
  const [webPhone, setWebPhone] = useState<WebPhone | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    async function initializeWebPhone() {
      // Initialize RingCentral SDK
      const sdk = new SDK({
        clientId: 'your-client-id',
        clientSecret: 'your-client-secret',
        server: SDK.server.production, // or .sandbox
      });

      const platform = sdk.platform();

      // Login (JWT or OAuth)
      await platform.login({
        jwt: 'your-jwt-token',
      });

      // Get SIP provision data
      const response = await platform.post('/restapi/v1.0/client-info/sip-provision', {
        sipInfo: [{ transport: 'WSS' }],
      });

      const sipData = await response.json();

      // Initialize WebPhone
      const phone = new WebPhone(sipData, {
        clientId: 'your-client-id',
        appName: 'YourApp',
        appVersion: '1.0.0',
        logLevel: 2,
        media: {
          remote: remoteVideoRef.current!,
          local: localVideoRef.current!,
        },
        audioHelper: {
          enabled: true,
          incoming: '/audio/incoming.ogg',
          outgoing: '/audio/outgoing.ogg',
        },
        enableQos: true,
      });

      // Listen for incoming calls
      phone.userAgent.on('invite', (session) => {
        console.log('Incoming call!');
        // Handle incoming call
        session.accept().then(() => {
          console.log('Call accepted');
        });
      });

      setWebPhone(phone);

      return () => {
        phone?.userAgent.unregister();
      };
    }

    initializeWebPhone();
  }, []);

  const makeCall = (phoneNumber: string) => {
    if (!webPhone) return;
    const session = webPhone.userAgent.invite(phoneNumber, {
      fromNumber: '+1234567890', // Your phone number
    });
    
    session.on('accepted', () => {
      console.log('Call connected');
    });
  };

  return (
    <div>
      <video ref={remoteVideoRef} hidden />
      <video ref={localVideoRef} hidden muted />
      <button onClick={() => makeCall('+1234567890')}>Call</button>
    </div>
  );
}
```

### React Hook Example

```typescript
// hooks/useWebPhone.ts
import { useEffect, useRef, useState } from 'react';
import WebPhone from '@/src/lib/ringcentral-webphone';
import { SDK } from '@ringcentral/sdk';

export function useWebPhone(config: {
  clientId: string;
  clientSecret: string;
  jwt?: string;
  server?: string;
}) {
  const [webPhone, setWebPhone] = useState<WebPhone | null>(null);
  const [isReady, setIsReady] = useState(false);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    // Initialize logic here
    // ... (similar to component example above)
  }, [config]);

  return {
    webPhone,
    isReady,
    remoteVideoRef,
    localVideoRef,
  };
}
```

## Features

- ✅ Make and receive calls
- ✅ Hold/Unhold
- ✅ Mute/Unmute
- ✅ Transfer calls
- ✅ DTMF tones
- ✅ Call recording
- ✅ Quality of Service (QoS) monitoring
- ✅ WebRTC audio/video support

## Important Notes

1. **Browser Compatibility**: Requires Chrome, Firefox, or Safari with WebRTC support
2. **HTTPS Required**: WebRTC requires HTTPS in production (localhost works for development)
3. **Microphone Permission**: Browser will request microphone access
4. **RingCentral Account**: You need a RingCentral account with VoIP Calling permissions
5. **Digital Line**: Requires a Digital Line attached to your extension for outbound calls

## Troubleshooting

- **Import errors**: Ensure all dependencies are installed and TypeScript paths are configured correctly
- **Audio not working**: Check browser permissions and ensure audio files are in the public folder
- **Connection issues**: Verify RingCentral credentials and network connectivity
- **WebRTC errors**: Ensure you're using HTTPS or localhost

## License

MIT (same as original ringcentral-web-phone library)

