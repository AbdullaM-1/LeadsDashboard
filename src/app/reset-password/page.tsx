'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/utils/supabase/client';

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });

      if (error) {
        throw error;
      }

      setSuccess(true);
      setTimeout(() => router.push('/dashboard'), 1500);
    } catch (err: any) {
      setError(err.message || 'Failed to reset password. The reset link may have expired.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="antialiased min-h-screen flex items-center justify-center p-6 bg-white overflow-hidden text-slate-900" style={{ fontFamily: "'Geist', sans-serif" }}>
      <style>{`
        .auth-panel {
            background: rgba(255, 255, 255, 0.45);
            backdrop-filter: blur(40px) saturate(220%);
            border: 1px solid rgba(0, 0, 0, 0.05);
            box-shadow:
                0 0 0 1px rgba(255, 255, 255, 0.9) inset,
                0 1px 2px rgba(0,0,0,0.01),
                0 20px 50px -10px rgba(0,0,0,0.08);
        }
        .mesh-leak {
            position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -1;
            background:
                radial-gradient(at 0% 0%, rgba(99, 102, 241, 0.06) 0px, transparent 45%),
                radial-gradient(at 100% 100%, rgba(16, 185, 129, 0.06) 0px, transparent 45%),
                radial-gradient(at 50% 50%, #ffffff 0%, #f8fafc 100%);
        }
        .glass-input {
            background: rgba(255, 255, 255, 0.6);
            border: 1px solid rgba(0, 0, 0, 0.05);
            transition: all 0.3s ease;
        }
        .glass-input:focus {
            background: #ffffff;
            border-color: #6366f1;
            box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.05);
            outline: none;
        }
      `}</style>

      <div className="mesh-leak"></div>

      <div className="w-full max-w-[440px] relative">
        <div className="absolute -inset-10 bg-indigo-500/5 blur-[100px] rounded-full"></div>

        <div className="auth-panel rounded-[3rem] p-10 lg:p-12 relative">
          <div className="flex flex-col items-center mb-10 text-center">
            <div className="h-14 w-14 bg-black rounded-2xl flex items-center justify-center text-white shadow-2xl mb-6">
              <i className="fa-solid fa-lock text-2xl leading-none"></i>
            </div>
            <h1 className="text-2xl font-black tracking-tighter uppercase italic">Set New <span className="text-indigo-600">Password</span></h1>
          </div>

          {error && (
            <div className="mb-6 p-3 bg-red-50 border border-red-100 rounded-xl text-red-600 text-xs font-bold text-center">
              {error}
            </div>
          )}

          {success ? (
            <div className="p-4 bg-emerald-50 border border-emerald-100 rounded-2xl text-emerald-700 text-xs font-bold text-center">
              Password updated. Redirecting to your dashboard...
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-6">
              <div>
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1 mb-2 block">New Password</label>
                <input
                  type="password"
                  placeholder="••••••••"
                  className="glass-input w-full rounded-2xl py-4 px-4 text-sm font-semibold text-slate-900 placeholder:text-slate-300"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>

              <div>
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1 mb-2 block">Confirm Password</label>
                <input
                  type="password"
                  placeholder="••••••••"
                  className="glass-input w-full rounded-2xl py-4 px-4 text-sm font-semibold text-slate-900 placeholder:text-slate-300"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-black text-white rounded-2xl py-4 text-[11px] font-black uppercase tracking-[0.2em] shadow-2xl shadow-indigo-100 hover:scale-[1.02] active:scale-95 transition-all duration-300 disabled:opacity-70 disabled:cursor-not-allowed flex justify-center items-center"
              >
                {loading ? (
                  <i className="fa-solid fa-circle-notch fa-spin"></i>
                ) : (
                  'Update Password'
                )}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
