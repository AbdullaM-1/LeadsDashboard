'use client';

import { useEffect, useRef, useState } from 'react';
import WebPhone from '@/lib/ringcentral-webphone';
import { SDK } from '@ringcentral/sdk';

export default function WebPhonePage() {
  const [webPhone, setWebPhone] = useState<WebPhone | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [status, setStatus] = useState('Initializing...');
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    async function initializeWebPhone() {
      try {
        const clientId = process.env.NEXT_PUBLIC_RC_CLIENT_ID;
        const clientSecret = process.env.NEXT_PUBLIC_RC_CLIENT_SECRET;
        const server = process.env.NEXT_PUBLIC_RC_SERVER || 'https://platform.ringcentral.com';
        const jwt = process.env.NEXT_PUBLIC_RC_JWT;

        if (!clientId || !clientSecret || !jwt) {
          setStatus('Error: RingCentral credentials not configured. Please set NEXT_PUBLIC_RC_CLIENT_ID, NEXT_PUBLIC_RC_CLIENT_SECRET, and NEXT_PUBLIC_RC_JWT in your environment variables.');
          return;
        }

        setStatus('Initializing SDK...');

        // Initialize RingCentral SDK
        // Determine server constant based on URL
        const serverConstant = server.includes('ringcentral.com') && !server.includes('devtest')
          ? SDK.server.production
          : SDK.server.sandbox;

        const sdk = new SDK({
          clientId,
          clientSecret,
          server: serverConstant,
        });

        const platform = sdk.platform();

        setStatus('Logging in with JWT...');

        // Login with JWT
        try {
          const jwtToken = jwt.trim();
          console.log('Attempting login with JWT (length:', jwtToken.length, ')');
          
          await platform.login({
            jwt: jwtToken,
          });
          
          console.log('Login successful!');
        } catch (loginError: any) {
          console.error('Login error details:', loginError);
          const errorMessage = loginError.message || loginError.msg || 'Unknown error';
          setStatus(`Login failed: ${errorMessage}`);
          
          // Check if it's a JWT parsing error
          if (errorMessage.includes('assertion') || errorMessage.includes('JWT') || errorMessage.includes('parse')) {
            setStatus(`JWT Error: The token may be expired or invalid. Please generate a new JWT from RingCentral Developer Console.`);
          }
          return;
        }

        setStatus('Logged in. Fetching SIP provision...');

        // Get SIP provision data
        const response = await platform.post('/restapi/v1.0/client-info/sip-provision', {
          sipInfo: [{ transport: 'WSS' }],
        });

        const sipData = await response.json();

        setStatus('Initializing WebPhone...');

        // Initialize WebPhone
        const phone = new WebPhone(sipData, {
          clientId: process.env.NEXT_PUBLIC_RC_CLIENT_ID || 'your-client-id',
          appName: 'LeadsDashboard',
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
          setStatus('Incoming call...');
          // Handle incoming call
          session.accept().then(() => {
            console.log('Call accepted');
            setStatus('Call connected');
          });
          
          if (session.on) {
            session.on('terminated', () => {
              setStatus('Call terminated');
            });
          }
        });
        
        // Listen for registration events
        phone.userAgent.on('registered', () => {
            setStatus('Ready to make calls');
            setIsReady(true);
        });
        
         phone.userAgent.on('unregistered', () => {
            setStatus('Unregistered');
            setIsReady(false);
        });
        
         phone.userAgent.on('registrationFailed', () => {
            setStatus('Registration failed');
            setIsReady(false);
        });

        setWebPhone(phone);
        
        // Trigger registration
        if (phone.userAgent && typeof phone.userAgent.register === 'function') {
          await phone.userAgent.register();
        } else {
          throw new Error('UserAgent not initialized or register method not available');
        }

      } catch (error: any) {
        console.error('Failed to initialize WebPhone:', error);
        setStatus(`Initialization Error: ${error.message}`);
      }
    }

    initializeWebPhone();
    
    return () => {
        // Cleanup if needed
        // webPhone?.userAgent.unregister();
    }
  }, []);

  const makeCall = () => {
    if (!webPhone || !phoneNumber) return;
    
    setStatus(`Calling ${phoneNumber}...`);
    
    const session = webPhone.userAgent.invite(phoneNumber, {
      fromNumber: '+1234567890', // Replace with your verified number
    });
    
    if (session.on) {
      session.on('accepted', () => {
        console.log('Call connected');
        setStatus('Call connected');
      });
      
      session.on('terminated', () => {
        console.log('Call terminated');
        setStatus('Call terminated');
      });
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-8">
      <div className="bg-white rounded-3xl shadow-xl p-10 max-w-md w-full border border-slate-100">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-4 text-2xl shadow-lg shadow-blue-100">
            <i className="fa-solid fa-phone"></i>
          </div>
          <h1 className="text-2xl font-black text-slate-900 tracking-tight">Web Phone</h1>
          <p className="text-sm text-slate-400 font-bold mt-2 uppercase tracking-widest">{status}</p>
        </div>

        {/* Video Elements (Hidden for Audio-only calls, but required by library) */}
        <video ref={remoteVideoRef} hidden />
        <video ref={localVideoRef} hidden muted />

        <div className="space-y-6">
          <div>
            <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">
              Phone Number
            </label>
            <input
              type="tel"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="+1 (555) 000-0000"
              className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-lg font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all placeholder:text-slate-300"
            />
          </div>

          <button
            onClick={makeCall}
            disabled={!isReady || !phoneNumber}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl py-4 font-black uppercase tracking-widest shadow-xl shadow-blue-200 transition-all active:scale-95 flex items-center justify-center gap-2"
          >
            <i className="fa-solid fa-phone"></i> Call Now
          </button>
          
          {!isReady && (
             <div className="p-4 bg-amber-50 border border-amber-100 rounded-xl text-xs text-amber-700 leading-relaxed">
                <strong>Note:</strong> You need to configure your RingCentral credentials (JWT, Client ID, etc.) in the code or environment variables for this to connect.
             </div>
          )}
        </div>
      </div>
    </div>
  );
}

