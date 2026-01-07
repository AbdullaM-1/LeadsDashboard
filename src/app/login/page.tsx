'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/utils/supabase/client';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        throw error;
      }

      router.push('/dashboard');
    } catch (err: any) {
      setError(err.message || 'An error occurred during login');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="antialiased min-h-screen flex items-center justify-center p-6 bg-white overflow-hidden text-slate-900" style={{ fontFamily: "'Geist', sans-serif" }}>
      <style>{`
        :root {
            --p-indigo: #6366f1;
            --glass-rim: rgba(255, 255, 255, 0.9);
            --auth-bg: #ffffff;
        }
        
        /* High-Fidelity Noise Texture overlay */
        .grain {
            position: fixed; inset: 0; opacity: 0.015; pointer-events: none; z-index: 999;
            background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
        }

        /* The "Aether" Refractive Panel */
        .auth-panel {
            background: rgba(255, 255, 255, 0.45);
            backdrop-filter: blur(40px) saturate(220%);
            border: 1px solid rgba(0, 0, 0, 0.05);
            box-shadow: 
                0 0 0 1px var(--glass-rim) inset,
                0 1px 2px rgba(0,0,0,0.01),
                0 20px 50px -10px rgba(0,0,0,0.08);
            transition: all 0.6s cubic-bezier(0.15, 1, 0.3, 1);
        }

        /* Mesh Light Leaks */
        .mesh-leak {
            position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -1;
            background: 
                radial-gradient(at 0% 0%, rgba(99, 102, 241, 0.06) 0px, transparent 45%),
                radial-gradient(at 100% 100%, rgba(16, 185, 129, 0.06) 0px, transparent 45%),
                radial-gradient(at 50% 50%, #ffffff 0%, #f8fafc 100%);
        }

        /* High-Fidelity Input Styling */
        .glass-input {
            background: rgba(255, 255, 255, 0.6);
            border: 1px solid rgba(0, 0, 0, 0.05);
            transition: all 0.3s ease;
        }
        .glass-input:focus {
            background: #ffffff;
            border-color: var(--p-indigo);
            box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.05);
            outline: none;
        }

        @keyframes float-slow {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-10px); }
        }
        .animate-float { animation: float-slow 6s ease-in-out infinite; }
      `}</style>
      
      <div className="grain"></div>
      <div className="mesh-leak"></div>

      <div className="w-full max-w-[440px] relative">
        {/* Background Glow behind the card */}
        <div className="absolute -inset-10 bg-indigo-500/5 blur-[100px] rounded-full"></div>
        
        {/* Main Auth Panel */}
        <div className="auth-panel rounded-[3rem] p-10 lg:p-12 relative animate-float">
            
            {/* Branding */}
            <div className="flex flex-col items-center mb-10">
                <div className="h-14 w-14 bg-black rounded-2xl flex items-center justify-center text-white shadow-2xl mb-6">
                    <i className="fa-solid fa-square-rss text-2xl"></i>
                </div>
                <h1 className="text-2xl font-black tracking-tighter uppercase italic text-center">Integrated <span className="text-indigo-600">Financials</span></h1>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em] mt-2">Custom CRM</p>
            </div>

            {/* Error Message */}
            {error && (
              <div className="mb-6 p-3 bg-red-50 border border-red-100 rounded-xl text-red-600 text-xs font-bold text-center">
                {error}
              </div>
            )}

            {/* Login Form */}
            <form onSubmit={handleLogin} className="space-y-6">
                <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1 mb-2 block">Email</label>
                    <div className="relative">
                        <i className="fa-solid fa-envelope absolute left-4 top-1/2 -translate-y-1/2 text-slate-300 text-xs"></i>
                        <input 
                          type="email" 
                          placeholder="name@company.com" 
                          className="glass-input w-full rounded-2xl py-4 pl-11 pr-4 text-sm font-semibold text-slate-900 placeholder:text-slate-300"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          required
                        />
                    </div>
                </div>

                <div>
                    <div className="flex justify-between items-center ml-1 mb-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Password</label>
                        <a href="#" className="text-[10px] font-black text-indigo-600 uppercase tracking-widest hover:underline">Forgot?</a>
                    </div>
                    <div className="relative">
                        <i className="fa-solid fa-lock absolute left-4 top-1/2 -translate-y-1/2 text-slate-300 text-xs"></i>
                        <input 
                          type="password" 
                          placeholder="••••••••" 
                          className="glass-input w-full rounded-2xl py-4 pl-11 pr-4 text-sm font-semibold text-slate-900 placeholder:text-slate-300"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          required
                        />
                    </div>
                </div>

                {/* <div className="flex items-center gap-3 px-1">
                    <input type="checkbox" id="remember" className="w-4 h-4 rounded-md border-slate-200 text-indigo-600 focus:ring-indigo-500" />
                    <label htmlFor="remember" className="text-xs font-bold text-slate-500 cursor-pointer">Persist session on this device</label>
                </div> */}

                <button 
                  type="submit" 
                  disabled={loading}
                  className="w-full bg-black text-white rounded-2xl py-4 text-[11px] font-black uppercase tracking-[0.2em] shadow-2xl shadow-indigo-100 hover:scale-[1.02] active:scale-95 transition-all duration-300 disabled:opacity-70 disabled:cursor-not-allowed flex justify-center items-center"
                >
                  {loading ? (
                    <i className="fa-solid fa-circle-notch fa-spin"></i>
                  ) : (
                    'Login'
                  )}
                </button>
            </form>

            {/* Social/Other Auth */}
            <div className="mt-10">
                <div className="relative mb-8">
                    <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-slate-100"></div></div>
                    <div className="relative flex justify-center text-[10px] font-black uppercase"><span className="bg-white px-4 text-slate-300 tracking-widest"></span></div>
                </div>

                {/* <div className="grid grid-cols-2 gap-4">
                    <button type="button" className="flex items-center justify-center gap-3 bg-white border border-slate-100 rounded-2xl py-3 hover:bg-slate-50 transition-colors">
                        <i className="fa-brands fa-google text-slate-400"></i>
                        <span className="text-[10px] font-bold text-slate-600">Google</span>
                    </button>
                    <button type="button" className="flex items-center justify-center gap-3 bg-white border border-slate-100 rounded-2xl py-3 hover:bg-slate-50 transition-colors">
                        <i className="fa-brands fa-apple text-slate-400"></i>
                        <span className="text-[10px] font-bold text-slate-600">Apple</span>
                    </button>
                </div> */}
            </div>
        </div>

        {/* Footer link */}
        <p className="text-center mt-10 text-xs font-bold text-slate-400 uppercase tracking-widest">
            New node? <a href="#" className="text-indigo-600 hover:underline">Request Credentials</a>
        </p>
      </div>
    </div>
  );
}

