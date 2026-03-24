'use client';

import { useEffect, useRef, useState } from 'react';
import WebPhone from '@/lib/ringcentral-webphone';
import { SDK } from '@ringcentral/sdk';

const INITIALIZATION_FAILURE_MESSAGE = 'Initialization failed. Please refresh the page.';

export default function WebPhonePage() {
  const [webPhone, setWebPhone] = useState<WebPhone | null>(null);
  const [currentSession, setCurrentSession] = useState<any | null>(null);
  const [isInCall, setIsInCall] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isOnHold, setIsOnHold] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [status, setStatus] = useState('Initializing...');
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const attachSessionHandlers = (session: any) => {
      session.on('accepted', () => {
        console.log('Call connected');
        setCurrentSession(session);
        setIsInCall(true);
        setIsMuted(false);
        setIsOnHold(false);
        setStatus('Call connected');
      });

      session.on('terminated', () => {
        console.log('Call terminated');
        setCurrentSession(null);
        setIsInCall(false);
        setIsMuted(false);
        setIsOnHold(false);
        setStatus('Call terminated');
      });
    };

    async function initializeWebPhone() {
      try {
        const clientId = process.env.NEXT_PUBLIC_RC_CLIENT_ID;
        const clientSecret = process.env.NEXT_PUBLIC_RC_CLIENT_SECRET;
        const server = process.env.NEXT_PUBLIC_RC_SERVER || 'https://platform.ringcentral.com';
        const jwt = process.env.NEXT_PUBLIC_RC_JWT;

        if (!clientId || !clientSecret || !jwt) {
          console.error('RingCentral credentials not configured');
          setStatus(INITIALIZATION_FAILURE_MESSAGE);
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
          setStatus(INITIALIZATION_FAILURE_MESSAGE);
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
          logLevel: 0,
          builtinEnabled: false,
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
          attachSessionHandlers(session);
          // Handle incoming call
          session.accept().catch((error: unknown) => {
            console.error('Failed to accept incoming call:', error);
            setStatus('Failed to accept incoming call');
          });
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
        setStatus(INITIALIZATION_FAILURE_MESSAGE);
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

    session.on('accepted', () => {
      console.log('Call connected');
      setCurrentSession(session);
      setIsInCall(true);
      setIsMuted(false);
      setIsOnHold(false);
      setStatus('Call connected');
    });

    session.on('terminated', () => {
      console.log('Call terminated');
      setCurrentSession(null);
      setIsInCall(false);
      setIsMuted(false);
      setIsOnHold(false);
      setStatus('Call terminated');
    });
  };

  const toggleMute = () => {
    if (!currentSession) return;

    if (typeof currentSession.mute !== 'function' || typeof currentSession.unmute !== 'function') {
      setStatus('Mute control is unavailable for this call');
      return;
    }

    if (isMuted) {
      currentSession.unmute?.();
      setIsMuted(false);
      setStatus('Call unmuted');
      return;
    }

    currentSession.mute?.();
    setIsMuted(true);
    setStatus('Call muted');
  };

  const toggleHold = async () => {
    if (!currentSession) return;

    if (typeof currentSession.hold !== 'function' || typeof currentSession.unhold !== 'function') {
      setStatus('Hold control is unavailable for this call');
      return;
    }

    try {
      if (isOnHold) {
        await currentSession.unhold?.();
        setIsOnHold(false);
        setStatus('Call resumed');
        return;
      }

      await currentSession.hold?.();
      setIsOnHold(true);
      setStatus('Call on hold');
    } catch (error) {
      console.error('Failed to toggle hold:', error);
      setStatus('Could not change hold state');
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

          {isInCall && currentSession && (
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={toggleMute}
                className="w-full bg-slate-700 hover:bg-slate-800 text-white rounded-xl py-3 font-black uppercase tracking-widest transition-all active:scale-95 flex items-center justify-center gap-2"
              >
                <i className={`fa-solid ${isMuted ? 'fa-microphone-slash' : 'fa-microphone'}`}></i>
                {isMuted ? 'Unmute' : 'Mute'}
              </button>
              <button
                onClick={toggleHold}
                className="w-full bg-amber-500 hover:bg-amber-600 text-white rounded-xl py-3 font-black uppercase tracking-widest transition-all active:scale-95 flex items-center justify-center gap-2"
              >
                <i className={`fa-solid ${isOnHold ? 'fa-play' : 'fa-pause'}`}></i>
                {isOnHold ? 'Resume' : 'Hold'}
              </button>
            </div>
          )}
          
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

