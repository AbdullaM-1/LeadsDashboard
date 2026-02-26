'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/utils/supabase/client';
import { getCurrentUserRole, isAdmin } from '@/utils/roles';
import Papa from 'papaparse';
import WebPhone from '@/lib/ringcentral-webphone';
import { SDK } from '@ringcentral/sdk';
import Chart from 'chart.js/auto';
import { toast } from 'sonner';

interface Lead {
  id: string;
  first_name: string;
  last_name: string;
  middle_name?: string;
  email: string;
  phone: string;
  status: string;
  ai_score: number;
  created_at: string;
  tags: string[];
  address_line1?: string;
  address_line2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  ip_address?: string;
  date_of_birth?: string;
  lead_age?: string;
  source?: string;
}

type SortConfig = {
  key: keyof Lead | 'name' | 'contact';
  direction: 'asc' | 'desc';
} | null;

type DateFilterMode =
  | 'all'
  | 'today'
  | 'last3'
  | 'week'
  | 'date'
  | 'month'
  | 'customMonth';

// NW# (No Working Number) = unreachable leads. W# (Wrong Number) = incorrect data. BZ (Busy Signal) = temporary, retry.
// These must remain distinct dispositions; never merge or map one to the other.
const DISPOSITION_OPTIONS = [
  'No Answer',
  'Voice Mail',
  'Left Voice Mail',
  'Call Back',
  'Do Not Call',
  'NW# (No Working Number)',
  'W# (Wrong Number)',
  'BZ (Busy Signal)',
  'Not Interested',
  'Not Qualified',
  'No Tax Debt',
  'Qualified',
] as const;

const STATUS_FILTERS = ['All', 'New', ...DISPOSITION_OPTIONS] as const;

// Each disposition has its own DB value(s). Do not alias BZ, NW#, or W# (Wrong Number) to each other.
const STATUS_QUERY_MAP: Record<string, string[]> = {
  All: [],
  New: ['New'],
  'No Answer': ['No Answer'],
  'Voice Mail': ['Voice Mail'],
  'Left Voice Mail': ['Left Voice Mail', 'Left Voicemail'],
  'Call Back': ['Call Back'],
  'Do Not Call': ['Do Not Call'],
  'NW# (No Working Number)': ['NW# (No Working Number)'],
  'W# (Wrong Number)': ['W# (Wrong Number)'],
  'BZ (Busy Signal)': ['BZ (Busy Signal)'],
  'Not Interested': ['Not Interested'],
  'Not Qualified': ['Not Qualified'],
  'No Tax Debt': ['No Tax Debt'],
  Qualified: ['Qualified', 'Qualified Lead'],
};

const PROCESSED_STATUS_DB_VALUES = Array.from(
  new Set(
    DISPOSITION_OPTIONS.flatMap(
      (status) => STATUS_QUERY_MAP[status] ?? [status]
    )
  )
);

const getDayRange = (date: Date) => {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
};

const getMonthRange = (monthValue: string) => {
  const [yearStr, monthStr] = monthValue.split('-');
  if (!yearStr || !monthStr) {
    const now = new Date();
    return getDayRange(now);
  }
  const year = Number(yearStr);
  const month = Number(monthStr) - 1;
  const start = new Date(year, month, 1, 0, 0, 0, 0);
  const end = new Date(year, month + 1, 1, 0, 0, 0, 0);
  return { start: start.toISOString(), end: end.toISOString() };
};

const getLastNDaysRange = (days: number) => {
  const end = new Date();
  end.setHours(24, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  start.setHours(0, 0, 0, 0);
  return { start: start.toISOString(), end: end.toISOString() };
};

const getCurrentMonthValue = () => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${now.getFullYear()}-${month}`;
};

const INITIAL_LEAD_FORM = {
  first_name: '',
  last_name: '',
  email: '',
  phone: '',
  address_line1: '',
  city: '',
  state: '',
  postal_code: '',
  source: 'Manual',
  status: 'New',
  tags: '',
};

const getDisplayStatusFromDb = (status?: string | null) => {
  if (!status) return 'New';
  const match = Object.entries(STATUS_QUERY_MAP).find(([, values]) =>
    values.includes(status)
  );
  return match ? match[0] : status;
};

// Maps display label to canonical DB value only. Never convert between NW# and W# (Wrong Number).
const getPrimaryStatusValue = (status: string) => {
  const values = STATUS_QUERY_MAP[status];
  if (values && values.length > 0) {
    return values[0];
  }
  return status;
};

const formatStatusForDisplay = (status?: string | null) => {
  if (!status) return 'New';
  return getDisplayStatusFromDb(status);
};

const normalizePhoneForMatch = (value?: string | null) => (value || '').replace(/\D/g, '').slice(-10);

// RingSense transcript may be stored either in `transcription` column or inside raw `insights` payload.
const getTranscriptSegmentsFromRecording = (recording: any): any[] => {
  if (!recording) return [];
  if (Array.isArray(recording.transcription)) return recording.transcription;
  const insightsRoot = recording.insights?.insights || recording.insights;
  const transcript = insightsRoot?.Transcript || insightsRoot?.transcript;
  return Array.isArray(transcript) ? transcript : [];
};

const hasSummaryInRecording = (recording: any): boolean => !!getSummaryFromRecording(recording);

const findBestRecordingMatch = (
  recordings: any[],
  params: {
    phoneNumber?: string;
    callType?: string;
    activityCreatedAt?: string;
    callStartedAt?: string;
    callEndedAt?: string;
    durationSeconds?: number;
  }
) => {
  if (!recordings || recordings.length === 0) return null;

  const normalizedPhone = normalizePhoneForMatch(params.phoneNumber);
  const targetStartTime = params.callStartedAt
    ? new Date(params.callStartedAt).getTime()
    : params.activityCreatedAt
      ? new Date(params.activityCreatedAt).getTime()
      : null;
  const targetEndTime = params.callEndedAt ? new Date(params.callEndedAt).getTime() : null;
  const expectedDuration = params.durationSeconds || 0;
  const expectedDirection = params.callType?.toLowerCase();

  const scored = recordings.map((recording) => {
    let score = 0;
    const transcriptSegments = getTranscriptSegmentsFromRecording(recording);
    const hasTranscript = transcriptSegments.length > 0;
    const hasSummary = hasSummaryInRecording(recording);
    if (hasTranscript) score += 40;
    if (hasSummary) score += 10;

    const fromNormalized = normalizePhoneForMatch(recording.from_number);
    const toNormalized = normalizePhoneForMatch(recording.to_number);
    const phoneMatches = !!normalizedPhone && (fromNormalized === normalizedPhone || toNormalized === normalizedPhone);
    if (phoneMatches) score += 50;

    const direction = String(recording.direction || '').toLowerCase();
    if (expectedDirection && direction.includes(expectedDirection)) score += 10;

    const recordingStartTime = recording.start_time ? new Date(recording.start_time).getTime() : null;
    const recordingCreatedTime = recording.created_at ? new Date(recording.created_at).getTime() : null;
    const referenceTime = recordingStartTime || recordingCreatedTime;
    if (referenceTime && targetStartTime) {
      const diffMinutes = Math.abs(referenceTime - targetStartTime) / 60000;
      if (diffMinutes <= 5) score += 30;
      else if (diffMinutes <= 15) score += 20;
      else if (diffMinutes <= 30) score += 10;
      else if (diffMinutes > 120) score -= 20;
    }

    if (targetEndTime && referenceTime) {
      const endDiffMinutes = Math.abs(referenceTime - targetEndTime) / 60000;
      if (endDiffMinutes <= 10) score += 8;
    }

    const recordingDuration = parseInt(String(recording.duration || 0), 10) || 0;
    if (expectedDuration > 0 && recordingDuration > 0) {
      const durationDiff = Math.abs(recordingDuration - expectedDuration);
      if (durationDiff <= 10) score += 20;
      else if (durationDiff <= 30) score += 12;
      else if (durationDiff <= 60) score += 6;
    }

    return { recording, score, hasTranscript, hasSummary, phoneMatches };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return null;

  // Prevent random wrong matches when there is no strong signal.
  const minimumScore = normalizedPhone ? 45 : 35;
  if (best.score < minimumScore) return null;
  if (!best.hasTranscript && !best.hasSummary) return null;

  return best.recording;
};

const INITIALIZATION_FAILURE_MESSAGE = 'Initialization failed. Please refresh the page.';

// --- Call Intelligence Modal Component ---
function CallIntelligenceModal({
  recording,
  phoneNumber,
  callType,
  duration,
  onClose
}: {
  recording: any;
  phoneNumber?: string;
  callType?: string;
  duration?: number;
  onClose: () => void;
}) {
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const formatTimeOnly = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  };

  // Get speaker names from speaker_info
  const getSpeakerName = (speakerId: string) => {
    if (recording.speaker_info && recording.speaker_info[speakerId]) {
      return recording.speaker_info[speakerId].name || `Speaker ${speakerId}`;
    }
    return `Speaker ${speakerId}`;
  };

  // Determine if speaker is agent or customer based on call type
  const isAgent = (speakerId: string, index: number) => {
    // First speaker is usually the agent for outbound, second for inbound
    if (callType === 'outbound') {
      return index === 0 || speakerId.includes('1') || speakerId === '1';
    } else {
      return index === 1 || speakerId.includes('2') || speakerId === '2';
    }
  };

  const totalDuration = recording.duration || duration || 0;
  const durationMinutes = Math.floor(totalDuration / 60);
  const durationSeconds = totalDuration % 60;
  const formattedDuration = `${durationMinutes}:${durationSeconds.toString().padStart(2, '0')}`;
  const transcriptSegments = getTranscriptSegmentsFromRecording(recording);

  // Close on Escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = 'auto';
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={onClose}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose}></div>
      
      {/* Modal Panel */}
      <div 
        className="relative w-full max-w-[85rem] h-[90vh] bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col transform transition-all"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="bg-white border-b border-slate-200 shrink-0 z-10">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="h-10 w-10 bg-indigo-50 text-indigo-600 rounded-lg flex items-center justify-center">
                <i className="fa-solid fa-phone text-lg"></i>
              </div>
              <div>
                <h2 className="text-lg font-bold text-slate-900 leading-tight">
                  {recording.from_name || phoneNumber || 'Call Recording'}
                </h2>
                <p className="text-xs font-medium text-slate-400">
                  ID: #{recording.call_id?.slice(-6) || 'N/A'} • {formatDate(recording.start_time || recording.created_at)} • {formatTimeOnly(recording.start_time || recording.created_at)}
                </p>
              </div>
              <span className="ml-2 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700 border border-emerald-200">
                {recording.direction || callType || 'Completed'}
              </span>
            </div>

            {/* Header Actions */}
            <div className="flex items-center gap-3">
              <button 
                onClick={onClose}
                className="p-2 text-slate-400 hover:text-red-500 transition hover:bg-red-50 rounded-full"
              >
                <i className="fa-solid fa-times text-xl"></i>
              </button>
            </div>
          </div>
        </header>

        {/* Content Grid */}
        <div className="flex-1 flex overflow-hidden">
          {/* Middle Panel: Transcript */}
          <main className="flex-1 bg-white flex flex-col relative min-w-0">
            {/* Transcript Toolbar */}
            <div className="h-12 border-b border-slate-100 flex items-center justify-between px-6 bg-white/90 backdrop-blur sticky top-0 z-10">
              <div className="flex items-center gap-2 text-slate-400 text-sm">
                <i className="fa-solid fa-search text-xs"></i>
                <input 
                  type="text" 
                  placeholder="Search transcript..." 
                  className="bg-transparent border-none focus:ring-0 text-slate-700 placeholder-slate-400 text-sm w-full outline-none"
                />
              </div>
              <div className="text-xs font-medium text-slate-400">Duration: {formattedDuration}</div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-6 space-y-8">
              {transcriptSegments.length > 0 ? (
                transcriptSegments.map((segment: any, index: number) => {
                  const speakerName = getSpeakerName(segment.speakerId);
                  const agent = isAgent(segment.speakerId, index);
                  
                  return (
                    <div key={index} className="flex gap-4 group">
                      <div className="flex-shrink-0 mt-1">
                        {agent ? (
                          <div className="w-8 h-8 rounded-full bg-slate-900 text-white flex items-center justify-center text-xs font-bold">
                            {speakerName.charAt(0).toUpperCase()}
                          </div>
                        ) : (
                          <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center text-xs font-bold">
                            {speakerName.charAt(0).toUpperCase()}
                          </div>
                        )}
                      </div>
                      <div className="max-w-2xl">
                        <div className="flex items-baseline gap-2 mb-1">
                          <span className="text-sm font-bold text-slate-900">{speakerName}</span>
                          <span className="text-[10px] text-slate-400 font-mono">{formatTime(segment.start)}</span>
                        </div>
                        <p className={`text-sm text-slate-700 leading-relaxed group-hover:text-slate-900 transition-colors ${
                          !agent ? 'bg-amber-50/50 -mx-2 px-2 py-1 rounded border-l-2 border-amber-400' : ''
                        }`}>
                          {segment.text}
                        </p>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="text-center py-12 text-slate-400">
                  <p>No transcript available</p>
                </div>
              )}
            </div>
          </main>

          {/* Right Sidebar: AI Intelligence */}
          <aside className="w-80 bg-white border-l border-slate-200 hidden xl:flex flex-col overflow-y-auto">
            {/* AI Summary Box */}
            <div className="p-6 bg-gradient-to-b from-indigo-50/50 to-white border-b border-slate-100">
              <div className="flex items-center gap-2 mb-3">
                <i className="fa-solid fa-info-circle text-indigo-600"></i>
                <h3 className="text-xs font-bold text-indigo-900 uppercase tracking-wide">AI Smart Summary</h3>
              </div>
              <p className="text-sm text-slate-600 leading-relaxed">
                {getSummaryFromRecording(recording) || 'No summary available for this call.'}
              </p>
            </div>

            {/* Call Details */}
            <div className="p-6 border-b border-slate-100">
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4">Call Details</h3>
              <div className="space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">Direction</span>
                  <span className="font-semibold text-slate-900">{recording.direction || callType || 'N/A'}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">From</span>
                  <span className="font-semibold text-slate-900">{recording.from_number || phoneNumber || 'N/A'}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">To</span>
                  <span className="font-semibold text-slate-900">{recording.to_number || 'N/A'}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">Duration</span>
                  <span className="font-semibold text-slate-900">{formattedDuration}</span>
                </div>
                {transcriptSegments.length > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-500">Segments</span>
                    <span className="font-semibold text-slate-900">{transcriptSegments.length}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Speaker Information */}
            {recording.speaker_info && Object.keys(recording.speaker_info).length > 0 && (
              <div className="p-6 border-b border-slate-100">
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Speakers</h3>
                <div className="space-y-2">
                  {Object.entries(recording.speaker_info).map(([speakerId, info]: [string, any]) => (
                    <div key={speakerId} className="text-sm">
                      <span className="font-semibold text-slate-900">{info.name || `Speaker ${speakerId}`}</span>
                      <span className="text-slate-500 ml-2">({speakerId})</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

// Helper function to extract summary from recording (checks multiple sources)
function getSummaryFromRecording(recording: any): string | null {
  if (!recording) return null;
  
  // First try direct summary field
  if (recording.summary && recording.summary.trim()) {
    return recording.summary;
  }
  
  // Try to extract from insights field (RingSense: Summary or summary)
  const insightsRoot = recording.insights?.insights || recording.insights;
  const summaryArray = insightsRoot?.Summary || insightsRoot?.summary;
  if (summaryArray) {
    if (Array.isArray(summaryArray) && summaryArray.length > 0) {
      const summaryValue = summaryArray[0]?.value || summaryArray[0]?.text || summaryArray[0]?.content;
      if (summaryValue && String(summaryValue).trim()) {
        return String(summaryValue).trim();
      }
    } else if (summaryArray?.value && String(summaryArray.value).trim()) {
      return String(summaryArray.value).trim();
    }
  }

  return null;
}

// --- Call Recording Display Component ---
function CallRecordingDisplay({ 
  activity, 
  metadata, 
  phoneNumber, 
  callType, 
  duration 
}: { 
  activity: any; 
  metadata: any; 
  phoneNumber?: string; 
  callType?: string; 
  duration?: number;
}) {
  const [recording, setRecording] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const syncAttemptedRef = useRef(false);

  // Format call duration helper
  const formatCallDuration = (seconds: number) => {
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (remainingSeconds === 0) {
      return `${minutes}m`;
    }
    return `${minutes}m ${remainingSeconds}s`;
  };
  
  // Get summary using helper
  const summaryText = recording ? getSummaryFromRecording(recording) : null;
  const transcriptSegments = recording ? getTranscriptSegmentsFromRecording(recording) : [];

  useEffect(() => {
    if (!activity.created_at || recording) {
      if (recording) setLoading(false);
      return;
    }

    const expectedDurationSeconds = parseInt(String(duration || metadata?.duration_seconds || metadata?.duration || 0), 10) || 0;
    const normalizedPhone = normalizePhoneForMatch(phoneNumber);
    const activityDate = new Date(activity.created_at);
    const syncWindowStart = new Date(activityDate.getTime() - 12 * 60 * 60 * 1000).toISOString();
    const syncWindowEnd = new Date(activityDate.getTime() + 12 * 60 * 60 * 1000).toISOString();

    const loadCandidateRecordings = async () => {
      let query = supabase.from('call_recordings').select('*');
      if (normalizedPhone) {
        query = query.or(`from_number.ilike.%${normalizedPhone}%,to_number.ilike.%${normalizedPhone}%`);
      } else {
        query = query
          .gte('start_time', syncWindowStart)
          .lte('start_time', syncWindowEnd);
      }
      const { data, error } = await query
        .order('start_time', { ascending: false })
        .limit(300);
      if (error) throw error;
      return data || [];
    };

    const findAndSetMatch = async () => {
      const candidates = await loadCandidateRecordings();
      if (candidates.length === 0) return false;
      const match = findBestRecordingMatch(candidates, {
        phoneNumber,
        callType,
        activityCreatedAt: activity.created_at,
        callStartedAt: metadata?.call_started_at,
        callEndedAt: metadata?.call_ended_at,
        durationSeconds: expectedDurationSeconds,
      });
      if (!match) return false;
      setRecording(match);
      return true;
    };

    setLoading(true);
    let refreshCount = 0;
    const maxRefreshes = 8; // 8 * 5 sec = 40 sec
    let interval: any = null;

    const run = async () => {
      try {
        const found = await findAndSetMatch();
        if (found) {
          setLoading(false);
          return;
        }

        // On-demand sync for older/missing calls (run once per card)
        if (!syncAttemptedRef.current) {
          syncAttemptedRef.current = true;
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          const { data: { session } } = await supabase.auth.getSession();
          if (session?.access_token) {
            headers.Authorization = `Bearer ${session.access_token}`;
          }

          const syncUrl = `/api/ringsense/insights?perPage=100&maxPages=4&limit=30&dateFrom=${encodeURIComponent(syncWindowStart)}&dateTo=${encodeURIComponent(syncWindowEnd)}${normalizedPhone ? `&phoneNumber=${encodeURIComponent(normalizedPhone)}` : ''}`;
          await fetch(syncUrl, { method: 'GET', headers });
          const foundAfterSync = await findAndSetMatch();
          if (foundAfterSync) {
            setLoading(false);
            return;
          }
        }

        interval = setInterval(async () => {
          if (refreshCount >= maxRefreshes) {
            clearInterval(interval);
            setLoading(false);
            return;
          }
          refreshCount++;
          const foundOnPoll = await findAndSetMatch();
          if (foundOnPoll) {
            clearInterval(interval);
            setLoading(false);
          }
        }, 5000);
      } catch (error) {
        console.error('Error loading call recording:', error);
        setLoading(false);
      }
    };

    run();

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [phoneNumber, callType, duration, activity.created_at, metadata, recording]);

  return (
    <div className="bg-blue-50 rounded-lg p-3 border border-blue-100 mt-3 space-y-2">
      {phoneNumber && (
        <div className="flex items-center gap-2">
          <i className="fa-solid fa-phone text-blue-600 text-xs"></i>
          <span className="text-xs font-semibold text-blue-700">
            {phoneNumber}
          </span>
          {callType && (
            <span className="text-xs text-blue-500">
              ({callType === 'outbound' ? 'Outbound' : 'Inbound'})
            </span>
          )}
        </div>
      )}
      {duration !== undefined && duration > 0 && (
        <div className="flex items-center gap-2">
          <i className="fa-solid fa-clock text-blue-600 text-xs"></i>
          <span className="text-xs font-semibold text-blue-700">
            Duration: {formatCallDuration(duration)}
          </span>
        </div>
      )}

      {/* Transcript and Summary */}
      {loading && !recording && (
        <div className="text-xs text-blue-600 mt-2">
          <i className="fa-solid fa-spinner fa-spin mr-1"></i>
          Loading transcript...
        </div>
      )}

      {recording && (
        <div className="mt-3 space-y-3">
          {/* Summary */}
          {summaryText && (
            <div className="bg-white rounded-lg p-3 border border-blue-200">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-bold text-blue-900 flex items-center gap-1.5">
                  <i className="fa-solid fa-file-lines text-blue-600"></i>
                  Call Summary
                </h4>
              </div>
              <p className="text-xs text-slate-700 leading-relaxed line-clamp-2">
                {summaryText}
              </p>
            </div>
          )}

          {/* View Transcription Button - Show if there's a transcription */}
          {transcriptSegments.length > 0 && (
            <button
              onClick={() => setShowModal(true)}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold px-4 py-2 rounded-lg transition-colors flex items-center justify-center gap-2 shadow-sm"
            >
              <i className="fa-solid fa-comments"></i>
              View Full Transcript ({transcriptSegments.length} segments)
            </button>
          )}

          {!summaryText && transcriptSegments.length === 0 && (
            <div className="text-xs text-slate-500 italic">
              No transcript or summary available for this call.
            </div>
          )}
        </div>
      )}

      {/* Call Intelligence Modal */}
      {showModal && recording && (
        <CallIntelligenceModal
          recording={recording}
          phoneNumber={phoneNumber}
          callType={callType}
          duration={duration}
          onClose={() => setShowModal(false)}
        />
      )}

      {!loading && !recording && phoneNumber && (
        <div className="text-xs text-slate-500 italic mt-2 space-y-2">
          <p>No recording found. Transcripts are available after calls are processed by RingSense.</p>
        </div>
      )}
    </div>
  );
}

// --- Overview Components ---

function MetricCard({ title, value, subtext, icon, trend, colorClass }: { title: string; value: string | number; subtext: string; icon: string; trend?: { value: number; positive: boolean }; colorClass: string }) {
  return (
    <div className="dashboard-card stats-card animate-fade-in">
      <div className="flex justify-between items-start">
        <div className={`stats-icon ${colorClass}`}>
          <i className={`fa-solid ${icon}`}></i>
        </div>
        {trend && (
          <div className={`status-badge flex items-center gap-1.5 ${trend.positive ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
            <span className={`w-1 h-1 rounded-full ${trend.positive ? 'bg-emerald-500' : 'bg-rose-500'}`}></span>
            {trend.positive ? '+' : '-'}{Math.abs(trend.value)}%
          </div>
        )}
      </div>
      <div>
        <h4 className="text-xs font-extrabold text-slate-400 uppercase tracking-wide mb-1.5">{title}</h4>
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-black text-slate-900 tracking-tight numbers">{value}</span>
        </div>
        <p className="text-xs text-slate-500 font-semibold mt-2.5 flex items-center gap-1.5 leading-relaxed">
          <i className="fa-solid fa-arrow-right text-[10px] opacity-30"></i>
          {subtext}
        </p>
      </div>
    </div>
  );
}

function IntelligenceHeatmap({ data }: { data: { hour: number; count: number }[] | undefined }) {
  const chartRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let chart: Chart | null = null;
    if (chartRef.current && data && data.length > 0) {
      const ctx = chartRef.current.getContext("2d");
      if (ctx) {
        chart = new Chart(ctx, {
          type: "bar",
          data: {
            labels: data.map(d => `${d.hour}:00`),
            datasets: [{
              data: data.map(d => d.count),
              backgroundColor: "#4F46E5",
              borderRadius: 4,
              hoverBackgroundColor: "#4338CA",
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                backgroundColor: '#1E293B',
                titleFont: { size: 10, weight: 'bold' },
                padding: 12,
                cornerRadius: 8,
              }
            },
            scales: {
              y: { beginAtZero: true, grid: { color: "#F1F5F9" }, ticks: { font: { size: 9 }, color: '#94A3B8' } },
               x: { grid: { display: false }, ticks: { font: { size: 9, weight: 'bold' }, color: '#94a3b8' } },
            },
          },
        });
      }
    }
    return () => chart?.destroy();
  }, [data]);

  return (
    <div className="dashboard-card p-6 flex flex-col h-full animate-fade-in" style={{ animationDelay: '0.2s' }}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-base font-extrabold text-slate-900 uppercase tracking-wide">Call Activity</h3>
          <p className="text-xs text-slate-400 font-semibold uppercase tracking-wide mt-1.5">Calls by hour</p>
        </div>
        <div className="w-10 h-10 rounded-xl bg-slate-50 flex items-center justify-center text-slate-400">
          <i className="fa-solid fa-chart-column text-base"></i>
        </div>
      </div>
      {!data || data.length === 0 ? (
        <div className="flex-1 flex items-center justify-center bg-slate-50 rounded-2xl border border-dashed border-slate-200 min-h-[280px]">
          <p className="text-xs font-extrabold text-slate-400 uppercase tracking-wide">Analyzing Activity Flow...</p>
        </div>
      ) : (
        <div className="flex-1 min-h-[280px]"><canvas ref={chartRef}></canvas></div>
      )}
    </div>
  );
}

function VelocityMap({ data }: { data: { label: string; count: number }[] }) {
  const chartRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let chart: Chart | null = null;
    if (chartRef.current) {
      const ctx = chartRef.current.getContext("2d");
      if (ctx) {
        const areaGradient = ctx.createLinearGradient(0, 0, 0, 300);
        areaGradient.addColorStop(0, "rgba(79, 70, 229, 0.1)");
        areaGradient.addColorStop(1, "rgba(255, 255, 255, 0)");

        chart = new Chart(ctx, {
          type: "line",
          data: {
            labels: data.map(d => d.label),
            datasets: [{
              label: "Volume",
              data: data.map(d => d.count),
              borderColor: "#4F46E5",
              borderWidth: 3,
              tension: 0.35,
              fill: true,
              backgroundColor: areaGradient,
              pointRadius: 0,
              pointHoverRadius: 6,
              pointHoverBackgroundColor: "#4F46E5",
              pointHoverBorderColor: "#ffffff",
              pointHoverBorderWidth: 2,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              y: { beginAtZero: true, grid: { color: "#F8FAFC" }, ticks: { font: { size: 9 }, color: "#94A3B8" } },
              x: { grid: { display: false }, ticks: { font: { size: 9 }, color: "#94A3B8" } },
            },
          },
        });
      }
    }
    return () => chart?.destroy();
  }, [data]);

  return (
    <div className="dashboard-card p-6 flex-1 flex flex-col h-full animate-fade-in">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-base font-extrabold text-slate-900 uppercase tracking-wide">Capture Velocity</h3>
          <p className="text-xs text-slate-400 font-semibold uppercase tracking-wide mt-1.5">Global acquisition index</p>
        </div>
        <div className="flex items-center gap-2 text-xs font-extrabold text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-full border border-indigo-100">
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse"></span>
          LIVE FEED
        </div>
      </div>
      <div className="flex-1 min-h-[280px]"><canvas ref={chartRef}></canvas></div>
    </div>
  );
}

function FunnelAnatomy({ metrics }: { metrics: any }) {
  const chartRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let chart: Chart | null = null;
    if (chartRef.current) {
      const ctx = chartRef.current.getContext("2d");
      if (ctx) {
        chart = new Chart(ctx, {
          type: "doughnut",
          data: {
            labels: ["Qualified", "New", "Pending", "Trash"],
            datasets: [{
              data: [metrics.qualifiedLeads, metrics.newLeads, metrics.pendingLeads, metrics.discardedLeads],
              backgroundColor: ["#4F46E5", "#CBD5E1", "#94A3B8", "#F1F5F9"],
              borderWidth: 0,
              borderRadius: 8,
              spacing: 2,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: "85%",
            plugins: { legend: { display: false } },
            animation: { animateRotate: true, duration: 1000 },
          },
        });
      }
    }
    return () => chart?.destroy();
  }, [metrics]);

  return (
    <div className="dashboard-card p-6 w-full flex flex-col h-full animate-fade-in" style={{ animationDelay: '0.1s' }}>
      <div className="mb-6">
        <h3 className="text-base font-extrabold text-slate-900 uppercase tracking-wide">Lead Status</h3>
        <p className="text-xs text-slate-400 font-semibold uppercase tracking-wide mt-1.5">Status breakdown</p>
      </div>
      <div className="relative flex-1 min-h-[280px] mb-6">
        <canvas ref={chartRef}></canvas>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <p className="text-3xl font-black text-slate-900 tracking-tight">
            {metrics.totalLeads > 0 ? Math.round((metrics.qualifiedLeads / metrics.totalLeads) * 100) : 0}%
          </p>
          <p className="text-xs font-extrabold text-indigo-600 uppercase tracking-wide mt-1">Qualified</p>
        </div>
      </div>
      <div className="space-y-3 pt-6 border-t border-slate-100">
        <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-widest">
          <span className="text-slate-400">Success Rate</span>
          <span className="text-slate-900">{metrics.conversionRate}%</span>
        </div>
        <div className="h-1 w-full bg-slate-100 rounded-full overflow-hidden">
          <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${Math.min(metrics.conversionRate, 100)}%` }}></div>
        </div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const [activeView, setActiveView] = useState<'overview' | 'dialer' | 'contacts' | 'settings'>('overview');
  const [userIsAdmin, setUserIsAdmin] = useState(false);
  const [hasOpenedContact, setHasOpenedContact] = useState(false);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [activeLead, setActiveLead] = useState<Lead | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedLeads, setSelectedLeads] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [sortConfig, setSortConfig] = useState<SortConfig>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalLeads, setTotalLeads] = useState(0);
  const [viewMode, setViewMode] = useState<'all' | 'untouched'>('all');
  const [statusFilter, setStatusFilter] = useState<string>('All');
  const [dateFilterMode, setDateFilterMode] = useState<DateFilterMode>('all');
  const [selectedDate, setSelectedDate] = useState('');
  const [selectedMonth, setSelectedMonth] = useState('');
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showLeadModal, setShowLeadModal] = useState(false);
  const [isCreatingLead, setIsCreatingLead] = useState(false);
  const [newLead, setNewLead] = useState({ ...INITIAL_LEAD_FORM });
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null);
  const [importTags, setImportTags] = useState('Imported');
  const [importSource, setImportSource] = useState('CSV Import');
  const [importError, setImportError] = useState<string | null>(null);
  const [showTagInput, setShowTagInput] = useState(false);
  const [newTagValue, setNewTagValue] = useState('');
  const [showDuplicateModal, setShowDuplicateModal] = useState(false);
  const [duplicateLeads, setDuplicateLeads] = useState<any[]>([]);
  const [isTagSaving, setIsTagSaving] = useState(false);
  const [pageCursors, setPageCursors] = useState<Record<number, { created_at: string; id: string } | null>>({});
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteStatusFilter, setDeleteStatusFilter] = useState<string>('All');
  const [isDeleting, setIsDeleting] = useState(false);
  const [organizationUsers, setOrganizationUsers] = useState<any[]>([]);
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [newUser, setNewUser] = useState({ email: '', password: '', name: '', role: 'user' as 'admin' | 'user' });
  const [isCreatingUser, setIsCreatingUser] = useState(false);
  const [rcLinkedInSettings, setRcLinkedInSettings] = useState<boolean | null>(null);
  const [rcDisconnecting, setRcDisconnecting] = useState(false);
  const [selectedDisposition, setSelectedDisposition] = useState<string>('');
  const [itemsPerPage, setItemsPerPage] = useState(50);
  const [isSubmittingDisposition, setIsSubmittingDisposition] = useState(false);
  const [webPhone, setWebPhone] = useState<WebPhone | null>(null);
  const [webPhoneReady, setWebPhoneReady] = useState(false);
  const [webPhoneStatus, setWebPhoneStatus] = useState('Initializing...');
  const [rcNeedsConnect, setRcNeedsConnect] = useState(false);
  const [pendingDialLead, setPendingDialLead] = useState<Lead | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const localAudioRef = useRef<HTMLAudioElement>(null);
  const isDialingRef = useRef(false);
  const [currentCall, setCurrentCall] = useState<any>(null);
  const [powerDialerEnabled, setPowerDialerEnabled] = useState(false);
  const [isPowerDialing, setIsPowerDialing] = useState(false);
  const [powerDialingIndex, setPowerDialingIndex] = useState(0);
  const [powerDialingLeads, setPowerDialingLeads] = useState<Lead[]>([]);
  // CRITICAL: Store the fixed snapshot in a ref - this is the IMMUTABLE queue that never changes
  // This ref holds the original snapshot taken when power dialing starts
  const powerDialingQueueSnapshotRef = useRef<Lead[]>([]);
  const [leadActivities, setLeadActivities] = useState<any[]>([]);
  const [callStartTime, setCallStartTime] = useState<Date | null>(null);
  // Flag to prevent useEffect from auto-advancing when we're manually moving to next lead
  const isManuallyAdvancingRef = useRef(false);
  // Ref to track current call state (for use in closures)
  const currentCallRef = useRef<any>(null);
  // Power dialer: true when we should advance to next (for qualified: set only when call ends; for non-qualified: set when disposition is saved, and we end call from disposition handler)
  const callJustEndedRef = useRef(false);
  // Bump this when user saves disposition with call already ended so the advance effect re-runs and moves to next lead
  const [powerDialerAdvanceTrigger, setPowerDialerAdvanceTrigger] = useState(0);
  // State for call duration display (updates every second)
  const [callDuration, setCallDuration] = useState<number>(0);
  // State for mute status
  const [isMuted, setIsMuted] = useState(false);
  // Ref to track current active lead ID (for use in closures to prevent race conditions)
  const activeLeadIdRef = useRef<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Confirmation Modal State
  const [confirmationModal, setConfirmationModal] = useState<{
    show: boolean;
    message: string;
    onConfirm: () => void;
    onCancel?: () => void;
  }>({
    show: false,
    message: '',
    onConfirm: () => {},
  });

  // Helper function to show confirmation modal
  const showConfirmation = useCallback((message: string, onConfirm: () => void, onCancel?: () => void) => {
    setConfirmationModal({
      show: true,
      message,
      onConfirm,
      onCancel,
    });
  }, []);

  // Qualification Details State
  const [qualificationTaxDebt, setQualificationTaxDebt] = useState<string>('');
  const [qualificationTaxYear, setQualificationTaxYear] = useState<string>('');
  const [qualificationTaxType, setQualificationTaxType] = useState<string>('');

  // Sync qualification fields from active lead when switching leads
  useEffect(() => {
    if (!activeLead) {
      setQualificationTaxDebt('');
      setQualificationTaxYear('');
      setQualificationTaxType('');
      return;
    }
    const lead = activeLead as any;
    setQualificationTaxDebt(lead.estimated_debt != null && lead.estimated_debt !== '' ? String(lead.estimated_debt) : '');
    setQualificationTaxYear(Array.isArray(lead.unfiled_years) ? lead.unfiled_years.join(', ') : (lead.unfiled_years ?? ''));
    const taxTag = (lead.tags || []).find((t: string) => t.startsWith('TaxType:'));
    setQualificationTaxType(taxTag ? taxTag.replace('TaxType:', '') : '');
  }, [activeLead?.id]);

  // Overview Metrics State
  const [metrics, setMetrics] = useState({
    totalLeads: 0,
    newLeads: 0,
    qualifiedLeads: 0,
    discardedLeads: 0,
    pendingLeads: 0,
    todayCount: 0,
    conversionRate: 0,
    growth: 0,
    dailyVolume: [] as { label: string; count: number }[],
    activityHeatmap: [] as { hour: number; count: number }[],
    callsToday: 0,
    avgDuration: 0,
  });

  const getDateFilterLabel = () => {
    switch (dateFilterMode) {
      case 'today':
        return 'Today';
      case 'last3':
        return 'Last 3 Days';
      case 'week':
        return 'This Week';
      case 'date':
        return selectedDate ? `On ${new Date(selectedDate).toLocaleDateString()}` : 'Select Date';
      case 'month':
        return 'This Month';
      case 'customMonth':
        return selectedMonth
          ? new Date(`${selectedMonth}-01`).toLocaleString('default', { month: 'long', year: 'numeric' })
          : 'Select Month';
      default:
        return 'All Dates';
    }
  };

  // Fetch activities for a lead
  const fetchLeadActivities = useCallback(async (leadId: string) => {
    try {
      console.log('Fetching activities for lead:', leadId);

      // CRITICAL: Only clear activities if we're fetching for a different lead
      // This prevents clearing activities unnecessarily during rapid lead changes
      setLeadActivities((prevActivities) => {
        // Only clear if the current activities belong to a different lead
        if (prevActivities.length > 0 && prevActivities[0]?.lead_id !== leadId) {
          console.log('Clearing activities - switching from lead', prevActivities[0]?.lead_id, 'to', leadId);
          return [];
        }
        // Keep current activities if they belong to the same lead (prevents flickering)
        return prevActivities;
      });

      // Fetch ALL historical activities for this lead (no limit)
      // This ensures we show the complete activity history, not just recent ones
      const { data, error } = await supabase
        .from('lead_activities')
        .select('*')
        .eq('lead_id', leadId)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error fetching activities:', error);
        throw error;
      }

      console.log('Fetched ALL historical activities for lead', leadId, '- Total count:', data?.length || 0, 'activities');

      // CRITICAL: Before setting activities, verify that activeLead hasn't changed
      // This prevents race conditions where we fetch for lead A but activeLead is now lead B
      // Use ref to get the current value (not stale closure value)
      const currentActiveLeadId = activeLeadIdRef.current;
      if (currentActiveLeadId !== leadId) {
        console.log('Active lead changed during fetch - discarding results. Fetched for:', leadId, 'Current active:', currentActiveLeadId);
        return; // Don't set activities if we're no longer viewing this lead
      }

      // Normalize activities to ensure activity_type is set (fallback to 'type' if activity_type doesn't exist)
      const normalizedActivities = (data || []).map((activity: any) => ({
        ...activity,
        activity_type: activity.activity_type || activity.type?.toLowerCase() || 'unknown',
      }));

      // CRITICAL: Double-check that all activities belong to the requested lead
      // This is a safety check to prevent displaying activities from other leads
      const filteredActivities = normalizedActivities.filter((activity: any) => {
        const belongsToLead = activity.lead_id === leadId;
        if (!belongsToLead) {
          console.error('CRITICAL: Activity does not belong to requested lead!', {
            activityId: activity.id,
            activityLeadId: activity.lead_id,
            requestedLeadId: leadId
          });
        }
        return belongsToLead;
      });

      // CRITICAL: Final check before setting - ensure activeLead still matches
      // This prevents setting activities for a lead that's no longer active
      // Use ref to get the current value (not stale closure value)
      if (activeLeadIdRef.current === leadId) {
        console.log('Normalized and filtered activities for lead', leadId, '- Displaying', filteredActivities.length, 'historical activities (all activities from database)');
        setLeadActivities(filteredActivities);
      } else {
        console.log('Active lead changed after fetch - not setting activities. Fetched for:', leadId, 'Current active:', activeLeadIdRef.current);
      }
    } catch (error) {
      console.error('Error fetching activities:', error);
      // Only clear activities on error if we're still viewing the same lead
      if (activeLeadIdRef.current === leadId) {
        setLeadActivities([]);
      }
    }
  }, []);

  // Function to check admin status (can be called manually)
  const checkAdminStatus = useCallback(async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        console.log('[Admin Check] No user found');
        setUserIsAdmin(false);
        return false;
      }

      console.log('[Admin Check] User ID:', user.id);
      
      // Direct query to check role - bypass cache and add detailed error logging
      const { data: profile, error } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .single();

      console.log('[Admin Check] Profile query result:', { 
        profile, 
        error,
        errorCode: error?.code,
        errorMessage: error?.message,
        errorDetails: error?.details,
        errorHint: error?.hint
      });

      if (error) {
        // Only log error details, don't show empty object
        if (error.message || error.code) {
          console.error('[Admin Check] Error fetching profile:', {
            code: error.code,
            message: error.message,
            details: error.details,
            hint: error.hint
          });
        }
        
        // If it's an RLS error, log it specifically
        if (error.code === '42501' || error.message?.includes('permission') || error.message?.includes('policy')) {
          console.error('[Admin Check] RLS POLICY ERROR - User cannot read their own profile!');
          console.error('[Admin Check] This means the RLS policy "Users can view their own profile" is not working.');
        }
        
        // If profile doesn't exist, that's okay - user is not admin
        if (error.code === 'PGRST116') {
          console.log('[Admin Check] Profile not found - user is not admin');
        }
        
        setUserIsAdmin(false);
        return false;
      }

      if (!profile) {
        console.log('[Admin Check] No profile found');
        setUserIsAdmin(false);
        return false;
      }

      const isAdminUser = profile.role === 'admin';
      console.log('[Admin Check] Role:', profile.role, 'Is Admin:', isAdminUser);
      setUserIsAdmin(isAdminUser);
      return isAdminUser;
    } catch (error) {
      console.error('[Admin Check] Error:', error);
      setUserIsAdmin(false);
      return false;
    }
  }, []);

  // Check if user is admin - with retry logic and window focus listener
  useEffect(() => {
    // Check immediately
    checkAdminStatus();

    // Check after a short delay
    const timeoutId1 = setTimeout(checkAdminStatus, 1000);
    
    // Check again after 3 seconds
    const timeoutId2 = setTimeout(checkAdminStatus, 3000);

    // Check when window regains focus (user switches back to tab)
    const handleFocus = () => {
      console.log('[Admin Check] Window focused, rechecking admin status');
      checkAdminStatus();
    };
    window.addEventListener('focus', handleFocus);

    return () => {
      clearTimeout(timeoutId1);
      clearTimeout(timeoutId2);
      window.removeEventListener('focus', handleFocus);
    };
  }, [checkAdminStatus]);

  useEffect(() => {
    if (activeView === 'contacts') {
      fetchLeads();
    }
  }, [activeView, currentPage, sortConfig, viewMode, statusFilter, dateFilterMode, selectedDate, selectedMonth, itemsPerPage]);

  useEffect(() => {
    const displayStatus = getDisplayStatusFromDb(activeLead?.status);
    // Only set selectedDisposition if the lead has a disposition status
    // If lead is 'New' or has no status, leave it empty (nothing selected)
    if (DISPOSITION_OPTIONS.includes(displayStatus as typeof DISPOSITION_OPTIONS[number])) {
      setSelectedDisposition(displayStatus);
    } else {
      // Lead is new or has no disposition - don't select anything
      setSelectedDisposition('');
    }
    setShowTagInput(false);
    setNewTagValue('');

    // Update ref to track current active lead ID (for use in closures to prevent race conditions)
    activeLeadIdRef.current = activeLead?.id || null;

    // Fetch activities when active lead changes
    if (activeLead?.id) {
      fetchLeadActivities(activeLead.id);
    } else {
      setLeadActivities([]);
    }
  }, [activeLead?.id, fetchLeadActivities]);

  // Fetch organization users
  const fetchUsers = useCallback(async () => {
    setIsLoadingUsers(true);
    try {
      console.log('Fetching users from /api/users/list...');
      const response = await fetch('/api/users/list');
      console.log('Response status:', response.status);
      const data = await response.json();
      console.log('Response data:', data);

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch users');
      }

      setOrganizationUsers(data.users || []);
      console.log('Users fetched successfully:', data.users?.length || 0);
    } catch (error: any) {
      console.error('Error fetching users:', error);
      toast.error(error.message || 'Failed to fetch users. Please check console for details.');
    } finally {
      setIsLoadingUsers(false);
    }
  }, []);

  // Delete user function
  const deleteUser = useCallback(async (userId: string) => {
    showConfirmation(
      'Are you sure you want to delete this user? This action cannot be undone.',
      async () => {
        setDeletingUserId(userId);
        try {
          const { data: { session } } = await supabase.auth.getSession();
          if (!session) {
            toast.error('You must be logged in to delete users');
            setDeletingUserId(null);
            return;
          }

          const response = await fetch('/api/users/delete', {
            method: 'DELETE',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({ userId }),
          });

          const data = await response.json();

          if (!response.ok) {
            throw new Error(data.error || 'Failed to delete user');
          }

          // Refresh the users list
          await fetchUsers();
          toast.success('User deleted successfully');
        } catch (error: any) {
          console.error('Error deleting user:', error);
          toast.error(error.message || 'Failed to delete user');
        } finally {
          setDeletingUserId(null);
        }
      }
    );
  }, [fetchUsers, showConfirmation]);

  // Fetch users when settings view is active or when admin is on overview
  useEffect(() => {
    if ((activeView === 'settings' || (activeView === 'overview' && userIsAdmin)) && organizationUsers.length === 0) {
      console.log('Fetching users for admin view...');
      fetchUsers();
    }
  }, [activeView, fetchUsers, userIsAdmin, organizationUsers.length]);

  // Fetch RingCentral link status when settings view is active
  useEffect(() => {
    if (activeView !== 'settings') return;
    let cancelled = false;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        if (!cancelled) setRcLinkedInSettings(false);
        return;
      }
      try {
        const res = await fetch(`${window.location.origin}/api/auth/ringcentral/tokens`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        const data = await res.json();
        if (!cancelled) setRcLinkedInSettings(!!(data.linked && data.access_token));
      } catch {
        if (!cancelled) setRcLinkedInSettings(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activeView]);

  const [isDownloadingRecordings, setIsDownloadingRecordings] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState('');

  // Helper to trigger download of a blob
  const saveRecording = (blob: Blob, filename: string) => {
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  };

  const [rcToken, setRcToken] = useState<string | null>(null);

  useEffect(() => {
    // 1. Listen for Token
    const handleRcMessage = async (event: MessageEvent) => {
      const data = event.data;
      if (!data || !data.type) return;

      if (data.type === 'rc-adapter-pushAdapterState' && data.accessToken) {
        setRcToken(data.accessToken);
      }
    };
    window.addEventListener('message', handleRcMessage);
    return () => window.removeEventListener('message', handleRcMessage);
  }, []);

  // Update call duration every second when call is active
  useEffect(() => {
    if (!callStartTime || !currentCall) {
      setCallDuration(0);
      return;
    }

    const interval = setInterval(() => {
      const now = new Date();
      const elapsed = Math.floor((now.getTime() - callStartTime.getTime()) / 1000);
      setCallDuration(elapsed);
    }, 1000);

    return () => clearInterval(interval);
  }, [callStartTime, currentCall]);

  // Track mute state from session
  useEffect(() => {
    if (!currentCall) {
      setIsMuted(false);
      return;
    }

    // Check initial mute state
    setIsMuted(currentCall.muted || false);

    // Listen for mute state changes (if the session has events for this)
    // Note: Some WebPhone implementations may not have mute events, so we check on render
    const checkMuteState = () => {
      if (currentCall) {
        setIsMuted(currentCall.muted || false);
      }
    };

    // Check periodically (every 500ms) as fallback
    const interval = setInterval(checkMuteState, 500);

    return () => clearInterval(interval);
  }, [currentCall]);

  const handleDownloadAllRecordings = async () => {
    if (!rcToken) {
      // Request token if we don't have it yet
      const iframe = document.querySelector("#rc-widget") as HTMLIFrameElement;
      iframe?.contentWindow?.postMessage({
        type: 'rc-adapter-register-service',
        service: 'RcAdapter',
      }, '*');
      toast.warning('Please wait for the dialer to fully load and try again in a few seconds.');
      return;
    }

    showConfirmation(
      'This will download all recordings and voicemails (last 90 days) directly from RingCentral. Continue?',
      async () => {
        setIsDownloadingRecordings(true);
        setDownloadProgress('Starting...');

        try {
      const dateFrom = new Date();
      dateFrom.setDate(dateFrom.getDate() - 90);
      const dateFromIso = dateFrom.toISOString();
      const headers = { Authorization: `Bearer ${rcToken}` };

      // 1. Fetch Call Recordings
      setDownloadProgress('Fetching Call Log...');
      const callLogRes = await fetch(`https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/call-log?withRecording=true&dateFrom=${dateFromIso}&perPage=1000`, { headers });
      const callLogData = await callLogRes.json();
      const recordings = callLogData.records?.filter((r: any) => r.recording) || [];

      // 2. Fetch Voicemails
      setDownloadProgress('Fetching Voicemails...');
      const msgStoreRes = await fetch(`https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/message-store?messageType=VoiceMail&dateFrom=${dateFromIso}&perPage=1000`, { headers });
      const msgStoreData = await msgStoreRes.json();
      const voicemails = msgStoreData.records?.filter((r: any) =>
        r.type === 'VoiceMail' && r.attachments?.some((a: any) => a.type === 'AudioRecording')
      ) || [];

      const totalItems = recordings.length + voicemails.length;
      if (totalItems === 0) {
        toast.info('No recordings or voicemails found.');
        setIsDownloadingRecordings(false);
        return;
      }

      // 3. Download Items
      let count = 0;

      // Process Recordings
      for (const rec of recordings) {
        count++;
        setDownloadProgress(`Downloading ${count}/${totalItems} (Calls)`);

        const contentUrl = rec.recording.contentUri;

        try {
          const blobRes = await fetch(contentUrl, { headers });
          if (blobRes.ok) {
            const blob = await blobRes.blob();
            const filename = `call_${rec.startTime}_${rec.from?.phoneNumber || 'unknown'}.mp3`;
            saveRecording(blob, filename);
          }
        } catch (e) {
          console.error('Failed to download recording', e);
        }
        await new Promise(r => setTimeout(r, 800)); // Throttle
      }

      // Process Voicemails
      for (const vm of voicemails) {
        count++;
        setDownloadProgress(`Downloading ${count}/${totalItems} (Voicemails)`);

        const attachment = vm.attachments.find((a: any) => a.type === 'AudioRecording');
        if (attachment) {
          const contentUrl = attachment.uri || `https://platform.ringcentral.com/restapi/v1.0/account/~/message-store/${vm.id}/content/${attachment.id}`;

          try {
            const blobRes = await fetch(contentUrl, { headers });
            if (blobRes.ok) {
              const blob = await blobRes.blob();
              const filename = `voicemail_${vm.creationTime}_${vm.from?.phoneNumber || 'unknown'}.mp3`;
              saveRecording(blob, filename);
            }
          } catch (e) {
            console.error('Failed to download voicemail', e);
          }
          await new Promise(r => setTimeout(r, 800)); // Throttle
        }
      }

      setDownloadProgress('Done!');
      setTimeout(() => setIsDownloadingRecordings(false), 2000);

        } catch (error) {
          console.error('Download error:', error);
          toast.error('An error occurred during download.');
          setIsDownloadingRecordings(false);
        }
      }
    );
  };

  /*
  // Old logic replaced
  */

  // Initialize WebPhone
  useEffect(() => {
    async function initializeWebPhone() {
      try {
        // Wait for video elements to be available in DOM
        let retries = 0;
        while ((!remoteVideoRef.current || !localVideoRef.current) && retries < 10) {
          await new Promise(resolve => setTimeout(resolve, 100));
          retries++;
        }

        if (!remoteVideoRef.current || !localVideoRef.current) {
          setWebPhoneStatus('Error: Media elements not available. Please refresh the page.');
          console.error('Video elements not available after waiting');
          return;
        }

        const clientId = process.env.NEXT_PUBLIC_RC_CLIENT_ID;
        const clientSecret = process.env.NEXT_PUBLIC_RC_CLIENT_SECRET;
        const defaultServer = process.env.NEXT_PUBLIC_RC_SERVER || 'https://platform.ringcentral.com';

        if (!clientId || !clientSecret) {
          setWebPhoneStatus('Error: RingCentral app not configured (NEXT_PUBLIC_RC_CLIENT_ID, NEXT_PUBLIC_RC_CLIENT_SECRET).');
          return;
        }

        // Wait for auth to be restored (e.g. after page refresh) so we can load OAuth tokens
        let user: { id: string } | null = null;
        let session: { access_token: string } | null = null;
        for (let i = 0; i < 25; i++) {
          const { data: userData } = await supabase.auth.getUser();
          const { data: sessionData } = await supabase.auth.getSession();
          if (userData.user && sessionData.session) {
            user = userData.user;
            session = sessionData.session;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (!user || !session) {
          const { data: userData } = await supabase.auth.getUser();
          const { data: sessionData } = await supabase.auth.getSession();
          user = userData.user ?? null;
          session = sessionData.session ?? null;
        }

        const justLinkedRc = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('rc_linked') === '1';
        if (justLinkedRc && user && session) {
          await new Promise((r) => setTimeout(r, 600));
        }

        let server = defaultServer;
        let useOAuth = false;
        let oauthAccessToken: string | undefined;
        let oauthRefreshToken: string | undefined;
        let oauthExpiresAt: string | undefined;
        let oauthRefreshTokenExpiresIn: number | undefined;

        if (user) {
          const { data: profile } = await supabase
            .from('user_profiles')
            .select('rc_jwt, rc_server, rc_access_token')
            .eq('id', user.id)
            .single();
          if (profile?.rc_server?.trim()) server = profile.rc_server.trim();
          const shouldTryTokensApi = (profile?.rc_access_token || justLinkedRc) && session?.access_token;
          if (shouldTryTokensApi) {
            try {
              let tokensData: { linked?: boolean; access_token?: string; refresh_token?: string; expires_at?: string; refresh_token_expires_in?: number; error?: string } = {};
              let tokensRes = await fetch(`${window.location.origin}/api/auth/ringcentral/tokens`, {
                headers: { Authorization: `Bearer ${session.access_token}` },
              });
              tokensData = await tokensRes.json();
              if (tokensData.linked && tokensData.access_token) {
                oauthAccessToken = tokensData.access_token;
                oauthRefreshToken = tokensData.refresh_token;
                oauthExpiresAt = tokensData.expires_at;
                oauthRefreshTokenExpiresIn = tokensData.refresh_token_expires_in;
                useOAuth = true;
                console.log('[RC init] Using OAuth tokens from API for user:', user.id);
              } else if (justLinkedRc && !tokensData.linked) {
                await new Promise((r) => setTimeout(r, 1000));
                tokensRes = await fetch(`${window.location.origin}/api/auth/ringcentral/tokens`, {
                  headers: { Authorization: `Bearer ${session.access_token}` },
                });
                tokensData = await tokensRes.json();
                if (tokensData.linked && tokensData.access_token) {
                  oauthAccessToken = tokensData.access_token;
                  oauthRefreshToken = tokensData.refresh_token;
                  oauthExpiresAt = tokensData.expires_at;
                  oauthRefreshTokenExpiresIn = tokensData.refresh_token_expires_in;
                  useOAuth = true;
                  console.log('[RC init] Using OAuth tokens from API (after retry) for user:', user.id);
                } else {
                  console.warn('[RC init] Tokens API did not return linked tokens (after retry):', {
                    linked: tokensData.linked,
                    error: tokensData.error,
                    status: tokensRes.status,
                    userId: user.id,
                  });
                }
              } else {
                console.warn('[RC init] Tokens API did not return linked tokens:', {
                  linked: tokensData.linked,
                  error: tokensData.error,
                  status: tokensRes.status,
                  userId: user.id,
                });
              }
            } catch (fetchErr) {
              console.error('[RC init] Tokens API fetch failed:', fetchErr);
            }
          }
        }

        let jwt: string | undefined;
        if (!useOAuth && user) {
          const { data: p } = await supabase.from('user_profiles').select('rc_jwt').eq('id', user.id).single();
          jwt = p?.rc_jwt?.trim();
        }
        const envJwt = process.env.NEXT_PUBLIC_RC_JWT?.trim();

        if (!useOAuth && !oauthAccessToken && !jwt && !envJwt) {
          setWebPhoneStatus('Connect RingCentral to make calls');
          setRcNeedsConnect(true);
          return;
        }

        setWebPhoneStatus('Initializing SDK...');

        const serverConstant = server.includes('ringcentral.com') && !server.includes('devtest')
          ? SDK.server.production
          : SDK.server.sandbox;

        const sdk = new SDK({
          clientId,
          clientSecret,
          server: serverConstant,
        });

        const platform = sdk.platform();

        setWebPhoneStatus('Logging in...');

        if (useOAuth && oauthAccessToken) {
          const loginOptions: { access_token: string; refresh_token?: string; access_token_ttl?: number; expires_in?: string; refresh_token_expires_in?: string } = { access_token: oauthAccessToken };
          if (oauthRefreshToken) loginOptions.refresh_token = oauthRefreshToken;
          let accessTokenExpiresIn = 0;
          if (oauthExpiresAt) {
            accessTokenExpiresIn = Math.max(0, Math.floor((new Date(oauthExpiresAt).getTime() - Date.now()) / 1000));
            if (accessTokenExpiresIn > 0) {
              loginOptions.access_token_ttl = accessTokenExpiresIn;
              loginOptions.expires_in = String(accessTokenExpiresIn);
            }
          }
          if (accessTokenExpiresIn <= 0) loginOptions.expires_in = '3600';
          const refreshExpiresIn = oauthRefreshTokenExpiresIn != null && oauthRefreshTokenExpiresIn > 0 ? oauthRefreshTokenExpiresIn : 604800;
          loginOptions.refresh_token_expires_in = String(refreshExpiresIn);
          await platform.login(loginOptions);
        } else {
          await platform.login({ jwt: (jwt || envJwt)!.trim() });
        }

        setWebPhoneStatus('Fetching SIP provision...');

        const response = await platform.post('/restapi/v1.0/client-info/sip-provision', {
          sipInfo: [{ transport: 'WSS' }],
        });

        const sipData = await response.json();

        setWebPhoneStatus('Initializing WebPhone...');

        // Ensure refs are still available
        if (!remoteVideoRef.current || !localVideoRef.current) {
          setWebPhoneStatus('Error: Media elements lost. Please refresh the page.');
          console.error('Video elements not available during WebPhone initialization');
          return;
        }

        const phone = new WebPhone(sipData, {
          clientId,
          appName: 'LeadsDashboard',
          appVersion: '1.0.0',
          logLevel: 0, // Reduced logging for production
          builtinEnabled: false,
          media: {
            remote: remoteVideoRef.current,
            local: localVideoRef.current,
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
          setWebPhoneStatus('Incoming call...');
          setCurrentCall(session);
          currentCallRef.current = session;

          session.accept().then(() => {
            console.log('Call accepted');
            setWebPhoneStatus('Call connected');
            setCallStartTime(new Date());
          });

          session.on('terminated', () => {
            setWebPhoneStatus('Call ended');

            // Calculate call duration and save activity (always save, even if duration is 0)
            if (activeLead?.id) {
              const now = new Date();
              const duration = callStartTime
                ? Math.max(0, Math.floor((now.getTime() - callStartTime.getTime()) / 1000))
                : 0;

              console.log('Saving incoming call terminated activity:', {
                leadId: activeLead.id,
                duration,
                duration_seconds: duration,
                callStartTime: callStartTime?.toISOString(),
                endTime: now.toISOString(),
              });

              saveActivity(
                activeLead.id,
                'call',
                `Incoming call ended${duration > 0 ? ` - Duration: ${formatCallDuration(duration)}` : ''}`,
                {
                  duration_seconds: duration,
                  duration: duration, // Also save as duration for backward compatibility
                  call_type: 'inbound',
                  phone_number: activeLead.phone,
                  call_started_at: callStartTime?.toISOString() || null,
                  call_ended_at: now.toISOString(),
                }
              );

              // Fetch and save call recording after a delay (to allow RingCentral to process)
              if (duration > 0) {
                const callStartedAtForLookup = callStartTime || new Date(now.getTime() - duration * 1000);
                setTimeout(() => {
                  fetchAndSaveCallRecording(activeLead.phone, callStartedAtForLookup, 'inbound', activeLead.id);
                }, 10000); // Wait 10 seconds for RingCentral to process
              }
            }

            setCallStartTime(null);
            setCurrentCall(null);
            currentCallRef.current = null;
          });
        });

        // Listen for registration events
        phone.userAgent.on('registered', () => {
          console.log('WebPhone registered successfully');
          setWebPhoneStatus('Ready to call');
          setWebPhoneReady(true);
        });

        phone.userAgent.on('unregistered', () => {
          console.log('WebPhone unregistered');
          setWebPhoneStatus('Disconnected');
          setWebPhoneReady(false);
        });

        phone.userAgent.on('registrationFailed', (error: any) => {
          console.error('Registration failed:', error);
          setWebPhoneStatus(`Registration failed: ${error?.message || 'Unknown error'}`);
          setWebPhoneReady(false);
        });

        setWebPhone(phone);

        setWebPhoneStatus('Registering...');

        if (phone.userAgent && typeof phone.userAgent.register === 'function') {
          try {
            await phone.userAgent.register();
            console.log('Registration initiated, waiting for confirmation...');
            // Don't set ready here - wait for 'registered' event
          } catch (regError: any) {
            console.error('Registration error:', regError);
            setWebPhoneStatus(`Registration error: ${regError?.message || 'Failed to register'}`);
          }
        } else {
          setWebPhoneStatus('Error: UserAgent not available');
        }

      } catch (error: any) {
        const errMsg = error?.message ?? String(error);
        const errStack = error?.stack;
        const errCode = error?.code;
        const errResponse = error?.response;
        console.error('[RC init] WebPhone initialization failed:', {
          message: errMsg,
          code: errCode,
          stack: errStack,
          response: errResponse,
          full: error,
        });
        if (errResponse) {
          try {
            const cloned = errResponse.clone?.();
            if (cloned) console.error('[RC init] Error response body:', await cloned.text());
          } catch (_) {}
        }
        const isRcSessionInvalid = /refresh token has expired|refresh token is missing|token not found|token is revoked/i.test(errMsg);
        if (isRcSessionInvalid) {
          setRcNeedsConnect(true);
          setWebPhoneStatus('RingCentral session invalid or expired. Please sign in with RingCentral again.');
        } else {
          setWebPhoneStatus(`${INITIALIZATION_FAILURE_MESSAGE} (${errMsg})`);
        }
      }
    }

    initializeWebPhone();

    return () => {
      if (webPhone?.userAgent) {
        webPhone.userAgent.unregister();
      }
    };
  }, []);

  // Manual dial function
  const handleDial = useCallback(async (leadOverride?: Lead) => {
    const leadToDial = leadOverride || activeLead;
    if (!leadToDial || !leadToDial.phone || !webPhone || !webPhoneReady) {
      console.warn('Dial blocked: Phone/UA not ready');
      return;
    }

    if (currentCall || isDialingRef.current) {
      console.warn('Dial blocked: Call already in progress or starting');
      return;
    }

    // Check UA state - UA must be Started to invite
    const uaState = (webPhone.userAgent as any).state;
    if (uaState && uaState !== 'Started' && uaState !== 'Registered') {
      console.warn('Dial blocked: UserAgent in state', uaState);
      return;
    }

    try {
      isDialingRef.current = true;
      setWebPhoneStatus(`Dialing ${leadToDial.phone}...`);

      // Clean phone number (remove any formatting)
      const cleanNumber = leadToDial.phone.replace(/\D/g, '');

      // Ensure audio elements exist
      if (!remoteAudioRef.current) {
        const remoteAudio = document.createElement('audio');
        remoteAudio.id = 'remote-audio';
        remoteAudio.autoplay = true;
        document.body.appendChild(remoteAudio);
        remoteAudioRef.current = remoteAudio;
      }
      if (!localAudioRef.current) {
        const localAudio = document.createElement('audio');
        localAudio.id = 'local-audio';
        localAudio.muted = true;
        document.body.appendChild(localAudio);
        localAudioRef.current = localAudio;
      }

      // Verify media elements are still available and properly attached
      if (!remoteVideoRef.current || !localVideoRef.current) {
        console.error('Media elements not available when making call');
        setWebPhoneStatus('Error: Media elements not available. Please refresh the page.');
        isDialingRef.current = false;
        return;
      }

      // Ensure video elements are in the DOM and accessible
      // They should already be there, but verify
      if (!document.body.contains(remoteVideoRef.current) || !document.body.contains(localVideoRef.current)) {
        console.error('Media elements not in DOM');
        setWebPhoneStatus('Error: Media elements not in DOM. Please refresh the page.');
        isDialingRef.current = false;
        return;
      }

      console.log('Initiating invite to:', cleanNumber);
      console.log('Media elements available:', {
        remote: !!remoteVideoRef.current,
        local: !!localVideoRef.current,
        remoteInDOM: document.body.contains(remoteVideoRef.current),
        localInDOM: document.body.contains(localVideoRef.current),
      });

      const session = webPhone.userAgent.invite(cleanNumber, {
        fromNumber: cleanNumber,
      });

      setCurrentCall(session);

      session.on('accepted', () => {
        console.log('Call accepted');
        setWebPhoneStatus('Call connected');
        isDialingRef.current = false;
        setCallStartTime(new Date());
      });

      session.on('progress', () => {
        setWebPhoneStatus('Ringing...');
      });

      session.on('terminated', () => {
        console.log('Call terminated');
        setWebPhoneStatus('Call ended');
        isDialingRef.current = false;

        // Calculate call duration and save activity (always save, even if duration is 0)
        if (leadToDial?.id) {
          const now = new Date();
          const duration = callStartTime
            ? Math.max(0, Math.floor((now.getTime() - callStartTime.getTime()) / 1000))
            : 0;

          console.log('Saving outbound call terminated activity:', {
            leadId: leadToDial.id,
            duration,
            duration_seconds: duration,
            callStartTime: callStartTime?.toISOString(),
            endTime: now.toISOString(),
          });

          saveActivity(
            leadToDial.id,
            'call',
            `Call ended${duration > 0 ? ` - Duration: ${formatCallDuration(duration)}` : ''}`,
            {
              duration_seconds: duration,
              duration: duration, // Also save as duration for backward compatibility
              phone_number: leadToDial.phone,
              call_type: 'outbound',
              call_started_at: callStartTime?.toISOString() || null,
              call_ended_at: now.toISOString(),
            }
          );

          // Fetch and save call recording after a delay (to allow RingCentral to process)
          if (duration > 0) {
            const callStartedAtForLookup = callStartTime || new Date(now.getTime() - duration * 1000);
            setTimeout(() => {
              fetchAndSaveCallRecording(leadToDial.phone, callStartedAtForLookup, 'outbound', leadToDial.id);
            }, 10000); // Wait 10 seconds for RingCentral to process
          }
        }

        setCallStartTime(null);
        setCurrentCall(null);
        currentCallRef.current = null;
      });

      session.on('rejected', () => {
        console.log('Call rejected');
        setWebPhoneStatus('Call rejected');
        isDialingRef.current = false;

        if (leadToDial?.id) {
          saveActivity(
            leadToDial.id,
            'call',
            'Call rejected',
            {
              phone_number: leadToDial.phone,
              call_type: 'outbound',
              call_result: 'rejected',
            }
          );
        }

        setCallStartTime(null);
        setCurrentCall(null);
        currentCallRef.current = null;
      });

      session.on('failed', () => {
        console.log('Call failed');
        setWebPhoneStatus('Call failed');
        isDialingRef.current = false;

        if (leadToDial?.id) {
          saveActivity(
            leadToDial.id,
            'call',
            'Call failed',
            {
              phone_number: leadToDial.phone,
              call_type: 'outbound',
              call_result: 'failed',
            }
          );
        }

        setCallStartTime(null);
        setCurrentCall(null);
        currentCallRef.current = null;
      });

    } catch (error: any) {
      console.error('Failed to dial:', error);
      setWebPhoneStatus(`Dial failed: ${error.message || 'Unknown error'}`);
      isDialingRef.current = false;
      setCurrentCall(null);
      currentCallRef.current = null;
    }
  }, [webPhone, webPhoneReady, activeLead, currentCall, callStartTime]);

  // Start Power Dialing - dial all leads sequentially
  const startPowerDialing = useCallback(async (leadsOverride?: Lead[], forceResume?: boolean) => {
    if (!webPhone || !webPhoneReady) {
      toast.warning('WebPhone is not ready. Please wait for initialization.');
      return;
    }

    if (isPowerDialing) {
      // Stop (pause) power dialing — keep queue and index so user can resume later
      setIsPowerDialing(false);
      callJustEndedRef.current = false;
      isManuallyAdvancingRef.current = false;
      if (currentCall) {
        try {
          const session = currentCall as any;
          const sessionState = session.state || (session as any).sessionState;

          if (sessionState === 'Initial' || sessionState === 'Establishing') {
            // Call hasn't been established yet, cancel it
            if (session.cancel) {
              await session.cancel();
            } else if (session.bye) {
              await session.bye();
            }
          } else {
            // Call is established, use bye()
            if (session.bye) {
              await session.bye();
            } else if (session.terminate) {
              await session.terminate();
            }
          }
        } catch (e) {
          console.error('Error hanging up:', e);
          // Clear state on error
          setCurrentCall(null);
          currentCallRef.current = null;
          setCallStartTime(null);
        }
      }
      toast.info('Power dialer paused. Use "Resume Power Dialer" to continue from where you left off.');
      return;
    }

    // Resume from paused queue only when user explicitly clicks Resume
    const snapshot = powerDialingQueueSnapshotRef.current;
    if (forceResume && snapshot.length > 0 && powerDialingIndex < snapshot.length) {
      const resumeLead = snapshot[powerDialingIndex];
      if (resumeLead?.phone && webPhone && webPhoneReady) {
        setIsPowerDialing(true);
        setLoading(false);
        setActiveView('dialer');
        setActiveLead(resumeLead);
        toast.success(`Resuming from lead ${powerDialingIndex + 1} of ${snapshot.length}`);
        setTimeout(async () => {
          if (!resumeLead?.phone || !webPhone || !webPhoneReady) return;
          try {
            setWebPhoneStatus(`Dialing ${resumeLead.phone}...`);
            const cleanNumber = resumeLead.phone.replace(/\D/g, '');
            if (!remoteVideoRef.current || !localVideoRef.current) {
              toast.error('Media elements not ready. Please refresh the page.');
              return;
            }
            const session = webPhone.userAgent.invite(cleanNumber, { fromNumber: cleanNumber });
            setCurrentCall(session);
            currentCallRef.current = session;
            session.on('accepted', () => {
              setWebPhoneStatus('Call connected');
              setCallStartTime(new Date());
            });
            session.on('progress', () => setWebPhoneStatus('Ringing...'));
            session.on('terminated', () => {
              setWebPhoneStatus('Call ended');
              callJustEndedRef.current = true;
              if (resumeLead?.id) {
                const duration = callStartTime ? Math.floor((new Date().getTime() - callStartTime.getTime()) / 1000) : 0;
                saveActivity(resumeLead.id, 'call', `Call ended${duration > 0 ? ` - Duration: ${formatCallDuration(duration)}` : ''}`, {
                  duration_seconds: duration,
                  phone_number: resumeLead.phone,
                  call_type: 'outbound',
                });
              }
              setCallStartTime(null);
              setCurrentCall(null);
              currentCallRef.current = null;
            });
            session.on('rejected', () => {
              setWebPhoneStatus('Call rejected');
              callJustEndedRef.current = true;
              if (resumeLead?.id && callStartTime) {
                const duration = Math.floor((new Date().getTime() - callStartTime.getTime()) / 1000);
                saveActivity(resumeLead.id, 'call', `Call rejected - Duration: ${formatCallDuration(duration)}`, {
                  duration_seconds: duration,
                  phone_number: resumeLead.phone,
                  call_type: 'outbound',
                  call_result: 'rejected',
                });
              }
              setCallStartTime(null);
              setCurrentCall(null);
              currentCallRef.current = null;
            });
            session.on('failed', () => {
              setWebPhoneStatus('Call failed');
              callJustEndedRef.current = true;
              if (resumeLead?.id && callStartTime) {
                const duration = Math.floor((new Date().getTime() - callStartTime.getTime()) / 1000);
                saveActivity(resumeLead.id, 'call', `Call failed - Duration: ${formatCallDuration(duration)}`, {
                  duration_seconds: duration,
                  phone_number: resumeLead.phone,
                  call_type: 'outbound',
                  call_result: 'failed',
                });
              }
              setCallStartTime(null);
              setCurrentCall(null);
              currentCallRef.current = null;
            });
          } catch (error: any) {
            console.error('Failed to dial on resume:', error);
            setWebPhoneStatus(`Dial failed: ${error.message || 'Unknown error'}`);
            setCurrentCall(null);
            currentCallRef.current = null;
          }
        }, 500);
        return;
      }
    }

    try {
      setLoading(true);

      let leadsToDial: Lead[] = [];

      if (leadsOverride && leadsOverride.length > 0) {
        // When leads are explicitly provided (from selection bar), use them directly
        // Don't apply status filter - user explicitly selected these leads
        leadsToDial = leadsOverride;
      } else if (selectedLeads.size > 0) {
        // When leads are selected via checkboxes, fetch and use them directly
        // Don't apply status filter - user explicitly selected these leads
        const selectedIds = Array.from(selectedLeads);
        console.log('Power dialer - Fetching selected leads, IDs:', selectedIds, 'Count:', selectedIds.length);

        const { data: selectedLeadsData, error } = await supabase
          .from('leads')
          .select('*')
          .in('id', selectedIds);

        if (error) throw error;

        console.log('Power dialer - Fetched leads from DB:', selectedLeadsData?.length, 'leads');
        console.log('Power dialer - Fetched lead details:', selectedLeadsData?.map(l => ({
          id: l.id,
          name: `${l.first_name} ${l.last_name}`,
          phone: l.phone
        })));

        // Ensure we got all selected leads - if not, log warning
        if (selectedLeadsData && selectedLeadsData.length !== selectedIds.length) {
          const missingIds = selectedIds.filter(id => !selectedLeadsData.find(l => l.id === id));
          console.warn('Power dialer - Some selected leads were not returned from DB. Missing IDs:', missingIds);
        }

        leadsToDial = selectedLeadsData || [];
      } else {
        // No leads selected - use only the leads currently visible on the page (viewport)
        // This ensures power dialer only dials what the user can see
        // Note: The leads array is already filtered by statusFilter in fetchLeads,
        // so we can use it directly without additional filtering
        
        // Check if leads array is empty
        if (leads.length === 0) {
          console.warn('Power dialer - Leads array is empty! This might be a timing issue.');
          console.warn('Power dialer - Current view:', activeView, 'Status filter:', statusFilter);
          // Leads might not be loaded yet - this is a timing issue
          // The eligiblePowerDialCount shows the correct count, but leads state is stale
        }
        
        leadsToDial = leads;
        
        console.log('Power dialer - Using current page leads (viewport only):', leadsToDial.length, 'leads');
        console.log('Power dialer - Current status filter:', statusFilter, 'View mode:', viewMode);
        if (leadsToDial.length > 0) {
          console.log('Power dialer - Sample lead statuses:', leadsToDial.slice(0, 3).map(l => ({ id: l.id, status: l.status, phone: l.phone })));
        } else {
          console.warn('Power dialer - WARNING: leads array is empty! This might cause "No leads found" error.');
        }
      }

      // Filter leads with phone numbers
      // Note: We don't filter by needsDisposition here because the status filter already
      // determines which statuses to dial. If user selected "No Answer", we dial all "No Answer" leads.
      // IMPORTANT: We do NOT deduplicate by phone number - if user selected 4 leads with same phone, dial all 4
      const leadsWithPhone = leadsToDial.filter(lead =>
        lead.phone &&
        lead.phone.trim()
      );

      console.log('Power dialer - Total leads to dial:', leadsToDial.length);
      console.log('Power dialer - Leads with phone numbers:', leadsWithPhone.length);
      console.log('Power dialer - Leads without phone:', leadsToDial.length - leadsWithPhone.length);
      if (leadsOverride && leadsOverride.length > 0) {
        console.log('Power dialer - Using leadsOverride:', leadsOverride.map(l => ({ id: l.id, name: `${l.first_name} ${l.last_name}`, phone: l.phone })));
      }

      if (leadsWithPhone.length === 0) {
        if (leadsOverride && leadsOverride.length > 0) {
          toast.error('No selected leads have phone numbers.');
        } else if (selectedLeads.size > 0) {
          toast.error('No selected leads have phone numbers.');
        } else {
          // Provide more helpful error message
          if (leadsToDial.length === 0) {
            toast.error(`No leads found. Please make sure you're viewing leads in the contacts view and that leads are loaded.`);
          } else {
            toast.error(`None of the ${leadsToDial.length} lead(s) on this page have phone numbers. Please check your leads data.`);
          }
        }
        setLoading(false);
        return;
      }

      // CRITICAL: Create a deep copy of the leads array to ensure it's completely independent
      // This fixed array will be used for the entire power dialing session and will NOT be affected
      // by any changes to the main leads state, filters, or database updates
      const fixedPowerDialingQueue: Lead[] = leadsWithPhone.map(lead => ({
        ...lead,
        // Deep copy to ensure complete independence
      }));

      console.log('Power dialer - Created FIXED queue with', fixedPowerDialingQueue.length, 'leads');
      console.log('Power dialer - Queue lead IDs:', fixedPowerDialingQueue.map(l => l.id));

      // CRITICAL: Store the snapshot in BOTH state and ref
      // The ref is the IMMUTABLE source of truth that never changes
      // The state is used for display and can be updated (only lead properties, not array length)
      powerDialingQueueSnapshotRef.current = [...fixedPowerDialingQueue]; // Deep copy into ref
      setIsPowerDialing(true);
      setPowerDialingLeads([...fixedPowerDialingQueue]); // Also set in state for display
      setPowerDialingIndex(0);
      setLoading(false);

      console.log('Power dialer - Snapshot stored in ref. Length:', powerDialingQueueSnapshotRef.current.length);

      // Switch to dialer view
      setActiveView('dialer');

      // Start with first lead
      const firstLead = leadsWithPhone[0];
      setActiveLead(firstLead);

      // Wait a moment then dial directly - ensure WebPhone is registered
      setTimeout(async () => {
        if (firstLead?.phone && webPhone && webPhoneReady) {
          try {
            setWebPhoneStatus(`Dialing ${firstLead.phone}...`);
            const cleanNumber = firstLead.phone.replace(/\D/g, '');

            // Ensure video elements are accessible
            if (!remoteVideoRef.current || !localVideoRef.current) {
              console.error('Video elements not available');
              toast.error('Media elements not ready. Please refresh the page.');
              return;
            }

            const session = webPhone.userAgent.invite(cleanNumber, {
              fromNumber: cleanNumber,
            });

            setCurrentCall(session);

            session.on('accepted', () => {
              setWebPhoneStatus('Call connected');
              setCallStartTime(new Date());
            });

            session.on('progress', () => {
              setWebPhoneStatus('Ringing...');
            });

            session.on('terminated', () => {
              setWebPhoneStatus('Call ended');
              callJustEndedRef.current = true;

              // Calculate call duration and save activity (always save, even if duration is 0)
              if (firstLead?.id) {
                const now = new Date();
                const duration = callStartTime
                  ? Math.floor((now.getTime() - callStartTime.getTime()) / 1000)
                  : 0;

                console.log('Saving power dialer call terminated activity:', {
                  leadId: firstLead.id,
                  duration,
                });

                saveActivity(
                  firstLead.id,
                  'call',
                  `Call ended${duration > 0 ? ` - Duration: ${formatCallDuration(duration)}` : ''}`,
                  {
                    duration_seconds: duration,
                    phone_number: firstLead.phone,
                    call_type: 'outbound',
                    call_started_at: callStartTime?.toISOString() || null,
                    call_ended_at: now.toISOString(),
                  }
                );

                if (duration > 0) {
                  const callStartedAtForLookup = callStartTime || new Date(now.getTime() - duration * 1000);
                  setTimeout(() => {
                    fetchAndSaveCallRecording(firstLead.phone, callStartedAtForLookup, 'outbound', firstLead.id);
                  }, 10000);
                }
              }

              setCallStartTime(null);
              setCurrentCall(null);
              currentCallRef.current = null;
            });

            session.on('rejected', () => {
              setWebPhoneStatus('Call rejected');
              callJustEndedRef.current = true;

              // Save activity for rejected call
              if (firstLead?.id && callStartTime) {
                const duration = Math.floor((new Date().getTime() - callStartTime.getTime()) / 1000);
                saveActivity(
                  firstLead.id,
                  'call',
                  `Call rejected - Duration: ${formatCallDuration(duration)}`,
                  {
                    duration_seconds: duration,
                    phone_number: firstLead.phone,
                    call_type: 'outbound',
                    call_result: 'rejected',
                  }
                );
              }

              setCallStartTime(null);
              setCurrentCall(null);
              currentCallRef.current = null;
            });

            session.on('failed', () => {
              setWebPhoneStatus('Call failed');
              callJustEndedRef.current = true;

              // Save activity for failed call
              if (firstLead?.id && callStartTime) {
                const duration = Math.floor((new Date().getTime() - callStartTime.getTime()) / 1000);
                saveActivity(
                  firstLead.id,
                  'call',
                  `Call failed - Duration: ${formatCallDuration(duration)}`,
                  {
                    duration_seconds: duration,
                    phone_number: firstLead.phone,
                    call_type: 'outbound',
                    call_result: 'failed',
                  }
                );
              }

              setCallStartTime(null);
              setCurrentCall(null);
              currentCallRef.current = null;
            });
          } catch (error: any) {
            console.error('Failed to dial:', error);
            setWebPhoneStatus(`Dial failed: ${error.message || 'Unknown error'}`);
            setCurrentCall(null);
            currentCallRef.current = null;
          }
        }
      }, 2000);

    } catch (error: any) {
      console.error('Failed to fetch leads for power dialing:', error);
      toast.error('Failed to start power dialing. Please try again.');
      setLoading(false);
    }
  }, [webPhone, webPhoneReady, isPowerDialing, currentCall, selectedLeads, statusFilter, dateFilterMode, selectedDate, selectedMonth, viewMode, leads, activeView, powerDialingIndex]);

  // Move to next: for qualified we advance only when call has ended AND disposition saved; for non-qualified we advance as soon as disposition is saved (call is ended from disposition handler)
  useEffect(() => {
    if (!isPowerDialing || currentCall) return;
    if (!callJustEndedRef.current) return;

    if (powerDialingQueueSnapshotRef.current.length > 0 && powerDialingIndex < powerDialingQueueSnapshotRef.current.length && webPhone && webPhoneReady) {
      const dispositionAlreadySaved = activeLead?.status !== 'New';
      const delayMs = dispositionAlreadySaved ? 600 : 3000;
      const timer = setTimeout(() => {
        if (activeLead?.status === 'New') {
          callJustEndedRef.current = false;
          toast.info('Select a disposition to move to the next call.');
          return;
        }

        callJustEndedRef.current = false;
        // CRITICAL: Use the IMMUTABLE snapshot from ref - this is the source of truth
        const snapshot = powerDialingQueueSnapshotRef.current;
        const nextIndex = powerDialingIndex + 1;
        console.log('useEffect: Call ended and disposition saved. Moving to next lead. Index:', nextIndex, 'Snapshot length:', snapshot.length);

        if (nextIndex < snapshot.length) {
          setPowerDialingIndex(nextIndex);
          // Get lead from the IMMUTABLE snapshot
          const nextLead = snapshot[nextIndex];
          if (!nextLead) {
            console.error('Next lead not found at index', nextIndex, 'in snapshot array of length', snapshot.length);
            setIsPowerDialing(false);
            setPowerDialingLeads([]);
            powerDialingQueueSnapshotRef.current = [];
            isManuallyAdvancingRef.current = false; // Clear the flag
            setWebPhoneStatus('Error: Lead not found in queue');
            return;
          }
          console.log('useEffect: Setting next lead from snapshot:', nextLead.id);
          setActiveLead(nextLead);

          // Dial next lead after a short delay
          setTimeout(() => {
            // Clear the flag when dial starts (in case it was set from manual advancement)
            isManuallyAdvancingRef.current = false;

            // Double-check conditions before dialing - use ref to get latest currentCall value
            const hasActiveCall = currentCallRef.current !== null;
            if (nextLead?.phone && webPhone && webPhoneReady && !hasActiveCall && isPowerDialing) {
              try {
                // Use snapshot length for accurate count
                const snapshot = powerDialingQueueSnapshotRef.current;
                setWebPhoneStatus(`Dialing ${nextLead.phone}... (${nextIndex + 1}/${snapshot.length})`);
                console.log(`useEffect: Dialing lead ${nextIndex + 1} of ${snapshot.length} from snapshot`);
                console.log('useEffect: Conditions check - phone:', !!nextLead.phone, 'webPhone:', !!webPhone, 'webPhoneReady:', webPhoneReady, 'hasActiveCall:', hasActiveCall, 'isPowerDialing:', isPowerDialing);
                const cleanNumber = nextLead.phone.replace(/\D/g, '');

                // Ensure video elements are accessible
                if (!remoteVideoRef.current || !localVideoRef.current) {
                  console.error('useEffect: Video elements not available');
                  setWebPhoneStatus('Error: Media elements not ready');
                  return;
                }

                const session = webPhone.userAgent.invite(cleanNumber, {
                  fromNumber: cleanNumber,
                });

                setCurrentCall(session);
                currentCallRef.current = session;

                session.on('accepted', () => {
                  setWebPhoneStatus('Call connected');
                  setCallStartTime(new Date());
                });

                session.on('progress', () => {
                  setWebPhoneStatus('Ringing...');
                });

                session.on('terminated', () => {
                  setWebPhoneStatus('Call ended');
                  callJustEndedRef.current = true;

                  // Calculate call duration and save activity (always save, even if duration is 0)
                  if (nextLead?.id) {
                    const now = new Date();
                    const duration = callStartTime
                      ? Math.floor((now.getTime() - callStartTime.getTime()) / 1000)
                      : 0;

                    console.log('Saving sequential dialer call terminated activity:', {
                      leadId: nextLead.id,
                      duration,
                    });

                    saveActivity(
                      nextLead.id,
                      'call',
                      `Call ended${duration > 0 ? ` - Duration: ${formatCallDuration(duration)}` : ''}`,
                      {
                        duration_seconds: duration,
                        phone_number: nextLead.phone,
                        call_type: 'outbound',
                        call_started_at: callStartTime?.toISOString() || null,
                        call_ended_at: now.toISOString(),
                      }
                    );

                    if (duration > 0) {
                      const callStartedAtForLookup = callStartTime || new Date(now.getTime() - duration * 1000);
                      setTimeout(() => {
                        fetchAndSaveCallRecording(nextLead.phone, callStartedAtForLookup, 'outbound', nextLead.id);
                      }, 10000);
                    }
                  }

                  setCallStartTime(null);
                  setCurrentCall(null);
                  currentCallRef.current = null;
                });

                session.on('rejected', () => {
                  setWebPhoneStatus('Call rejected');
                  callJustEndedRef.current = true;

                  // Save activity for rejected call
                  if (nextLead?.id && callStartTime) {
                    const duration = Math.floor((new Date().getTime() - callStartTime.getTime()) / 1000);
                    saveActivity(
                      nextLead.id,
                      'call',
                      `Call rejected - Duration: ${formatCallDuration(duration)}`,
                      {
                        duration_seconds: duration,
                        phone_number: nextLead.phone,
                        call_type: 'outbound',
                        call_result: 'rejected',
                      }
                    );
                  }

                  setCallStartTime(null);
                  setCurrentCall(null);
                  currentCallRef.current = null;
                });

                session.on('failed', () => {
                  setWebPhoneStatus('Call failed');
                  callJustEndedRef.current = true;

                  // Save activity for failed call
                  if (nextLead?.id && callStartTime) {
                    const duration = Math.floor((new Date().getTime() - callStartTime.getTime()) / 1000);
                    saveActivity(
                      nextLead.id,
                      'call',
                      `Call failed - Duration: ${formatCallDuration(duration)}`,
                      {
                        duration_seconds: duration,
                        phone_number: nextLead.phone,
                        call_type: 'outbound',
                        call_result: 'failed',
                      }
                    );
                  }

                  setCallStartTime(null);
                  setCurrentCall(null);
                  currentCallRef.current = null;
                });
              } catch (error: any) {
                console.error('useEffect: Failed to dial:', error);
                setWebPhoneStatus(`Dial failed: ${error.message || 'Unknown error'}`);
                setCurrentCall(null);
                currentCallRef.current = null;
              }
            } else {
              console.warn('useEffect: Auto-dial conditions not met - call not started:', {
                hasPhone: !!nextLead?.phone,
                phone: nextLead?.phone,
                hasWebPhone: !!webPhone,
                webPhoneReady,
                hasCurrentCall: !!currentCall,
                isPowerDialing,
                nextIndex,
                snapshotLength: powerDialingQueueSnapshotRef.current.length
              });
            }
          }, 2000);
        } else {
          // Finished all leads
          const totalDialed = powerDialingQueueSnapshotRef.current.length;
          setIsPowerDialing(false);
          setPowerDialingIndex(0);
          setPowerDialingLeads([]);
          powerDialingQueueSnapshotRef.current = [];
          callJustEndedRef.current = false;
          setWebPhoneStatus('Power dialing complete');
          toast.success(`Power dialing complete! Dialed ${totalDialed} leads.`);
        }
      }, delayMs);

      return () => clearTimeout(timer);
    }
  }, [currentCall, isPowerDialing, powerDialingIndex, powerDialingLeads, activeLead, webPhone, webPhoneReady, powerDialerAdvanceTrigger]);

  // Auto-dial when active lead changes OR when a dial is requested from contacts list
  useEffect(() => {
    // Only auto-dial if:
    // 1. A manual dial was requested via contacts list (pendingDialLead)
    // 2. OR Power Dialer toggle is enabled (not during active sequential dialing)
    const manualRequest = pendingDialLead !== null;
    const autoDialRequest = powerDialerEnabled && !isPowerDialing;

    if ((manualRequest || autoDialRequest) && webPhone && webPhoneReady && !currentCall) {
      const targetLead = pendingDialLead || activeLead;

      if (targetLead?.phone) {
        // Add a delay to ensure WebPhone is fully registered and ready
        const timer = setTimeout(() => {
          // Double-check conditions before dialing
          if (webPhone && webPhoneReady && !currentCall) {
            console.log('Auto-dialing lead:', targetLead.first_name, targetLead.phone, manualRequest ? '(Manual Request)' : '(Power Dialer)');
            handleDial(targetLead);
            if (manualRequest) setPendingDialLead(null);
          }
        }, 1500); // 1.5 seconds delay

        return () => clearTimeout(timer);
      }
    }
  }, [activeLead?.id, pendingDialLead, webPhone, webPhoneReady, currentCall, handleDial, powerDialerEnabled, isPowerDialing]);

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    try {
      const from = (currentPage - 1) * itemsPerPage;
      const to = from + itemsPerPage - 1;
      const useCursorPagination = !sortConfig;
      const previousCursor = useCursorPagination ? pageCursors[currentPage - 1] : null;
      const shouldCount = useCursorPagination
        ? currentPage === 1 && Object.keys(pageCursors).length === 0
        : true;

      const selectOptions: { count?: 'exact' | 'estimated' | 'planned' } = {};
      if (shouldCount) {
        selectOptions.count = useCursorPagination ? 'estimated' : 'exact';
      }

      let query = supabase
        .from('leads')
        .select('*', selectOptions);

      if (viewMode === 'untouched') {
        const processedList = PROCESSED_STATUS_DB_VALUES.map((status) =>
          `"${status.replace(/"/g, '\\"')}"`
        ).join(',');
        if (processedList) {
          query = query.not('status', 'in', `(${processedList})`);
        }
      } else {
        if (statusFilter !== 'All') {
          const statusesToMatch = STATUS_QUERY_MAP[statusFilter] ?? [statusFilter];
          if (statusesToMatch.length === 1) {
            query = query.eq('status', statusesToMatch[0]);
          } else {
            query = query.in('status', statusesToMatch);
          }
        }

        if (dateFilterMode === 'today') {
          const { start, end } = getDayRange(new Date());
          query = query.gte('created_at', start).lt('created_at', end);
        } else if (dateFilterMode === 'last3') {
          const { start, end } = getLastNDaysRange(3);
          query = query.gte('created_at', start).lt('created_at', end);
        } else if (dateFilterMode === 'week') {
          const { start, end } = getLastNDaysRange(7);
          query = query.gte('created_at', start).lt('created_at', end);
        } else if (dateFilterMode === 'date' && selectedDate) {
          const { start, end } = getDayRange(new Date(selectedDate));
          query = query.gte('created_at', start).lt('created_at', end);
        } else if (dateFilterMode === 'month') {
          const { start, end } = getMonthRange(getCurrentMonthValue());
          query = query.gte('created_at', start).lt('created_at', end);
        } else if (dateFilterMode === 'customMonth' && selectedMonth) {
          const { start, end } = getMonthRange(selectedMonth);
          query = query.gte('created_at', start).lt('created_at', end);
        }
      }

      if (!sortConfig) {
        if (useCursorPagination) {
          query = query.order('created_at', { ascending: false }).order('id', { ascending: false });
        } else {
          query = query.order('created_at', { ascending: false });
        }
      } else {
        let dbKey = sortConfig.key;
        if (sortConfig.key === 'name') dbKey = 'first_name';
        if (sortConfig.key === 'contact') dbKey = 'email';
        query = query.order(dbKey as string, {
          ascending: sortConfig.direction === 'asc',
        });
      }

      if (useCursorPagination && previousCursor) {
        query = query.or(
          `created_at.lt.${previousCursor.created_at},and(created_at.eq.${previousCursor.created_at},id.lt.${previousCursor.id})`
        );
      }

      let data: Lead[] | null = null;
      let error = null;
      let count: number | null = null;

      if (useCursorPagination) {
        const response = await query.limit(itemsPerPage);
        data = response.data;
        error = response.error;
        count = response.count;
      } else {
        const response = await query.range(from, to);
        data = response.data;
        error = response.error;
        count = response.count;
      }

      if (error) throw error;
      const fetchedLeads = data || [];
      setLeads(fetchedLeads);

      if (typeof count === 'number') {
        setTotalLeads(count);
      }

      if (useCursorPagination) {
        const nextCursor =
          fetchedLeads.length === itemsPerPage
            ? {
              created_at: fetchedLeads[fetchedLeads.length - 1].created_at,
              id: fetchedLeads[fetchedLeads.length - 1].id,
            }
            : null;
        setPageCursors((prev) => ({
          ...prev,
          [currentPage]: nextCursor,
        }));
      } else {
        setPageCursors({});
      }

      if (fetchedLeads.length > 0 && !activeLead) {
        setActiveLead(fetchedLeads[0]);
      }
    } catch (error) {
      console.error('Error fetching leads:', error);
    } finally {
      setLoading(false);
    }
  }, [currentPage, sortConfig, viewMode, statusFilter, dateFilterMode, selectedDate, selectedMonth, itemsPerPage, activeLead, pageCursors]);

  // Fetch Overview Metrics
  const fetchDashboardMetrics = useCallback(async () => {
    try {
      const userRole = await getCurrentUserRole();
      const { data: { user } } = await supabase.auth.getUser();
      
      // Build count query with filters
      let countQuery = supabase.from("leads").select("id", { count: 'exact', head: true });
      
      if (userRole === 'user' && user) {
        countQuery = countQuery.eq('user_id', user.id);
      }
      if (userRole === 'admin' && selectedUserId) {
        countQuery = countQuery.eq('user_id', selectedUserId);
      }

      // Get total count using count query (no limit, accurate count)
      const { count: totalCount, error: countError } = await countQuery;
      
      if (countError) throw countError;
      const total = totalCount || 0;

      // Fetch all leads in batches to avoid Supabase's 1000 row limit
      // This is needed for accurate status breakdowns and daily volume calculations
      let allLeads: any[] = [];
      let page = 0;
      const pageSize = 1000;
      let hasMore = true;

      while (hasMore) {
        let batchQuery = supabase.from("leads").select("id, status, created_at, user_id");
        
        if (userRole === 'user' && user) {
          batchQuery = batchQuery.eq('user_id', user.id);
        }
        if (userRole === 'admin' && selectedUserId) {
          batchQuery = batchQuery.eq('user_id', selectedUserId);
        }

        const { data: batch, error: batchError } = await batchQuery
          .range(page * pageSize, (page + 1) * pageSize - 1);
        
        if (batchError) throw batchError;
        
        if (batch && batch.length > 0) {
          allLeads = [...allLeads, ...batch];
          hasMore = batch.length === pageSize;
          page++;
        } else {
          hasMore = false;
        }
      }

      const leads = allLeads;
      const now = new Date();

      // Calculate daily volume for last 7 days
      const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const last7Days: { label: string; count: number }[] = [];

      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dayName = days[d.getDay()];
        const dateStr = d.toISOString().split('T')[0];
        const count = leads.filter(l => l.created_at.startsWith(dateStr)).length;
        last7Days.push({ label: i === 0 ? "Today" : dayName, count });
      }

      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toISOString();

      const todayLeads = leads.filter(l => l.created_at >= startOfToday);
      const yesterdayLeads = leads.filter(l => l.created_at >= startOfYesterday && l.created_at < startOfToday);

      const newCount = leads.filter(l => l.status === "New").length;
      const qualifiedCount = leads.filter(l => ["Qualified", "Qualified Lead"].includes(l.status)).length;
      // Count discarded separately per disposition; NW# and W# (Wrong Number) stay distinct in reporting
      const discardedCount = leads.filter(l => ["Not Interested", "Do Not Call", "W# (Wrong Number)", "NW# (No Working Number)"].includes(l.status)).length;
      const pendingCount = leads.filter(l => ["Call Back", "Voice Mail", "Left Voice Mail"].includes(l.status)).length;

      const conversion = total > 0 ? (qualifiedCount / total) * 100 : 0;
      const growthValue = yesterdayLeads.length > 0
        ? ((todayLeads.length - yesterdayLeads.length) / yesterdayLeads.length) * 100
        : todayLeads.length > 0 ? 100 : 0;

      // 2. Fetch activities for behavioral analytics
      let activitiesQuery = supabase
        .from("lead_activities")
        .select("created_at, activity_type, metadata, lead_id, created_by");
      
      // If user (not admin), filter activities by their leads
      if (userRole === 'user' && user && leads) {
        const userLeadIds = leads.map(l => l.id);
        if (userLeadIds.length > 0) {
          activitiesQuery = activitiesQuery.in('lead_id', userLeadIds);
        } else {
          // No leads, so no activities
          activitiesQuery = activitiesQuery.eq('lead_id', '00000000-0000-0000-0000-000000000000'); // Non-existent ID
        }
      }
      // Admin sees all activities, but can filter by selected user
      if (userRole === 'admin' && selectedUserId) {
        activitiesQuery = activitiesQuery.eq('created_by', selectedUserId);
      }

      const { data: activities, error: activityError } = await activitiesQuery;

      let heatmap = Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0 }));
      let callsToday = 0;
      let totalDuration = 0;
      let callsWithDuration = 0;

      if (!activityError && activities) {
        // Build Heatmap for LAST 24 HOURS (Rolling index)
        activities.forEach(act => {
          const actDate = new Date(act.created_at);
          // Only activities from today for the 24 hour mapping or all time?
          // Usually, heatmaps represent "Average" or "Recent". Let's do Recent 3 Days to make it look active.
          const threeDaysAgo = new Date();
          threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

          if (actDate >= threeDaysAgo) {
            const hour = actDate.getHours();
            heatmap[hour].count++;
          }

          // Today's Stats
          if (act.created_at >= startOfToday) {
            if (act.activity_type === 'call') {
              callsToday++;

              // Handle metadata duration
              let duration = 0;
              if (act.metadata) {
                const meta = typeof act.metadata === 'string' ? JSON.parse(act.metadata) : act.metadata;
                // Check both duration_seconds (current) and duration (legacy) for backward compatibility
                duration = parseInt(meta.duration_seconds || meta.duration || 0);
              }

              if (duration > 0) {
                totalDuration += duration;
                callsWithDuration++;
              }
            }
          }
        });
      }

      setMetrics({
        totalLeads: total,
        newLeads: newCount,
        qualifiedLeads: qualifiedCount,
        discardedLeads: discardedCount,
        pendingLeads: pendingCount,
        todayCount: todayLeads.length,
        conversionRate: Math.round(conversion * 10) / 10,
        growth: Math.round(growthValue * 10) / 10,
        dailyVolume: last7Days,
        activityHeatmap: heatmap,
        callsToday: callsToday,
        avgDuration: callsWithDuration > 0 ? Math.round(totalDuration / callsWithDuration) : 0,
      });
    } catch (err) {
      console.error("Error fetching metrics:", err);
    }
  }, [selectedUserId]);

  useEffect(() => {
    if (activeView === 'overview') {
      fetchDashboardMetrics();
    }
  }, [activeView, fetchDashboardMetrics, selectedUserId]);

  // Save activity to database
  // Function to fetch and save call recording from RingCentral
  // Only calls API if recording doesn't exist in DB
  const fetchAndSaveCallRecording = async (phoneNumber: string, callStartTime: Date, callType: 'inbound' | 'outbound', leadId?: string) => {
    try {
      console.log('Checking for call recording:', { phoneNumber, callStartTime, callType, leadId });
      
      // First, check if recording already exists in DB (within 15 minute window)
      const timeWindowStart = new Date(callStartTime.getTime() - 5 * 60 * 1000);
      const timeWindowEnd = new Date(callStartTime.getTime() + 15 * 60 * 1000);
      const normalizedPhone = phoneNumber.replace(/\D/g, '');
      
      const { data: existingRecording } = await supabase
        .from('call_recordings')
        .select('*')
        .or(`from_number.ilike.%${normalizedPhone}%,to_number.ilike.%${normalizedPhone}%`)
        .gte('start_time', timeWindowStart.toISOString())
        .lte('start_time', timeWindowEnd.toISOString())
        .order('start_time', { ascending: false })
        .limit(1)
        .maybeSingle();
      
      if (existingRecording && (getTranscriptSegmentsFromRecording(existingRecording).length > 0 || hasSummaryInRecording(existingRecording))) {
        console.log('✓ Recording already exists in DB with transcript, skipping API call');
        
        // Refresh activities to show the recording
        if (leadId && fetchLeadActivities) {
          setTimeout(() => {
            fetchLeadActivities(leadId);
          }, 500);
        }
        
        return true;
      }
      
      // Recording doesn't exist or doesn't have transcript, fetch from API
      console.log('Recording not found in DB or missing transcript, fetching from API...');
      
      // Get the current session token if available (API also supports cookie-based auth fallback)
      const { data: { session } } = await supabase.auth.getSession();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (session?.access_token) {
        headers['Authorization'] = `Bearer ${session.access_token}`;
      }

      const dateFrom = new Date(callStartTime.getTime() - 30 * 60 * 1000).toISOString();
      const dateTo = new Date(callStartTime.getTime() + 90 * 60 * 1000).toISOString();
      const insightsUrl = `/api/ringsense/insights?perPage=100&maxPages=4&limit=20&dateFrom=${encodeURIComponent(dateFrom)}&dateTo=${encodeURIComponent(dateTo)}&phoneNumber=${encodeURIComponent(normalizedPhone)}`;

      const response = await fetch(insightsUrl, {
        method: 'GET',
        headers,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Failed to fetch call recordings:', response.status, response.statusText, errorText);
        return false;
      }

      const data = await response.json();
      
      if (data.saved > 0) {
        console.log('Call recordings fetched and saved successfully');
        
        // Refresh activities if we have a leadId
        if (leadId && fetchLeadActivities) {
          setTimeout(() => {
            fetchLeadActivities(leadId);
          }, 2000);
        }
        
        return true;
      }

      return false;
    } catch (error) {
      console.error('Error fetching call recording:', error);
      return false;
    }
  };

  const saveActivity = async (leadId: string, activityType: string, description: string, metadata?: any) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        console.warn('No user found, cannot save activity');
        return;
      }

      // Get user's email/name for display in timeline
      let userName = user.email || 'Unknown User';
      try {
        // Try to get user metadata (name if available)
        if (user.user_metadata?.name) {
          userName = user.user_metadata.name;
        } else if (user.user_metadata?.full_name) {
          userName = user.user_metadata.full_name;
        }
      } catch (e) {
        console.warn('Could not get user name, using email');
      }

      // Verify the lead exists and belongs to the user (required for RLS policy)
      const { data: leadData, error: leadError } = await supabase
        .from('leads')
        .select('id, user_id')
        .eq('id', leadId)
        .single();

      if (leadError || !leadData) {
        console.error('Lead not found or access denied:', leadError);
        return;
      }

      // Note: All users can now create activities for all leads (per updated RLS policies)
      // We still check if lead exists, but don't restrict by user_id
      // The user's name will be stored in metadata so all users can see who made the change

      // Map activity type to the old 'type' column format
      // Old schema uses: 'CALL', 'EMAIL', 'SMS', 'NOTE', 'STATUS_CHANGE'
      const typeMapping: Record<string, string> = {
        'call': 'CALL',
        'disposition_change': 'STATUS_CHANGE',
        'email': 'EMAIL',
        'sms': 'SMS',
        'note': 'NOTE',
      };

      // Save activity with both activity_type and type columns (type is required for backward compatibility)
      // Include user information in metadata for display in timeline
      const activityMetadata = {
        ...(metadata || {}),
        user_id: user.id,
        user_name: userName,
        user_email: user.email,
      };

      const activityData: any = {
        lead_id: leadId,
        activity_type: activityType,
        type: typeMapping[activityType.toLowerCase()] || activityType.toUpperCase(), // Old column requires uppercase and NOT NULL
        description,
        metadata: activityMetadata,
        created_by: user.id,
      };

      console.log('Saving activity:', {
        leadId,
        activityType,
        description,
        metadata,
        activityData,
        duration_seconds: metadata?.duration_seconds || metadata?.duration || 'N/A',
        final_metadata: activityMetadata,
      });

      const { data, error } = await supabase
        .from('lead_activities')
        .insert(activityData)
        .select()
        .single();

      if (error) {
        // Better error logging
        console.error('Error saving activity:', {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        console.error('Full error object:', JSON.stringify(error, null, 2));
        console.error('Activity data attempted:', JSON.stringify(activityData, null, 2));
        console.error('User ID:', user.id);
        console.error('Lead ID:', leadId);
        console.error('Lead user_id:', leadData.user_id);

        // Don't throw - we don't want to break the main flow if activity saving fails
        return;
      }

      console.log('Activity saved successfully:', data);

      // Refresh activities for the active lead immediately
      // CRITICAL: During power dialing, activeLead might change rapidly, so we need to check
      // if the saved activity's lead is still the active lead before refreshing
      // Use a ref or check the current state to avoid race conditions
      setTimeout(async () => {
        // Re-check activeLead after delay to handle rapid changes during power dialing
        const currentActiveLead = activeLead;
        if (currentActiveLead?.id === leadId) {
          console.log('Refreshing activities after save for lead:', leadId);
          await fetchLeadActivities(leadId);
        } else {
          console.log('Active lead changed during save - not refreshing activities. Saved for:', leadId, 'Current active:', currentActiveLead?.id);
        }
      }, 500);
    } catch (error) {
      console.error('Error saving activity:', error);
      // Don't throw - we don't want to break the main flow if activity saving fails
    }
  };

  // Format call duration
  const formatCallDuration = (seconds: number) => {
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (remainingSeconds === 0) {
      return `${minutes}m`;
    }
    return `${minutes}m ${remainingSeconds}s`;
  };

  // Format time ago
  const formatTimeAgo = (date: Date) => {
    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diffInSeconds < 60) {
      return `${diffInSeconds} ${diffInSeconds === 1 ? 'SEC' : 'SECS'} AGO`;
    }

    const diffInMinutes = Math.floor(diffInSeconds / 60);
    if (diffInMinutes < 60) {
      return `${diffInMinutes} ${diffInMinutes === 1 ? 'MIN' : 'MINS'} AGO`;
    }

    const diffInHours = Math.floor(diffInMinutes / 60);
    if (diffInHours < 24) {
      return `${diffInHours} ${diffInHours === 1 ? 'HOUR' : 'HOURS'} AGO`;
    }

    const diffInDays = Math.floor(diffInHours / 24);
    if (diffInDays < 7) {
      return `${diffInDays} ${diffInDays === 1 ? 'DAY' : 'DAYS'} AGO`;
    }

    const diffInWeeks = Math.floor(diffInDays / 7);
    if (diffInWeeks < 4) {
      return `${diffInWeeks} ${diffInWeeks === 1 ? 'WEEK' : 'WEEKS'} AGO`;
    }

    const diffInMonths = Math.floor(diffInDays / 30);
    return `${diffInMonths} ${diffInMonths === 1 ? 'MONTH' : 'MONTHS'} AGO`;
  };

  // Calculate eligible leads count for power dialing
  // Only count leads that are currently visible on the page (viewport)
  const eligiblePowerDialCount = useMemo(() => {
    // Only count leads from the current page/viewport that have phone numbers
    const leadsWithPhoneOnPage = leads.filter(lead =>
      lead.phone && lead.phone.trim()
    ).length;

    return leadsWithPhoneOnPage;
  }, [leads]);

  const toggleLeadSelection = (leadId: string) => {
    const newSelected = new Set(selectedLeads);
    if (newSelected.has(leadId)) {
      newSelected.delete(leadId);
    } else {
      newSelected.add(leadId);
    }
    setSelectedLeads(newSelected);
  };

  const handleSort = (key: keyof Lead | 'name' | 'contact') => {
    let direction: 'asc' | 'desc' = 'asc';

    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }

    setSortConfig({ key, direction });
    setPageCursors({});
    setCurrentPage(1); // Reset to first page on sort change
  };

  const handleLeadClick = (lead: Lead) => {
    setActiveLead(lead);
    setActiveView('dialer');
    setHasOpenedContact(true); // Mark that a contact has been opened
  };

  const handleLeadPhoneClick = (e: React.MouseEvent, lead: Lead) => {
    e.stopPropagation();
    setActiveLead(lead);
    setActiveView('dialer');
    setHasOpenedContact(true); // Mark that a contact has been opened
    setPendingDialLead(lead); // Queue the dial to start as soon as UI/Phone is ready
  };

  const resetPaginationState = () => {
    setPageCursors({});
    setCurrentPage(1);
  };

  const applyQuickDateFilter = (mode: DateFilterMode) => {
    setDateFilterMode(mode);
    resetPaginationState();
    if (mode !== 'date') {
      setSelectedDate('');
    }
    if (mode === 'month') {
      setSelectedMonth(getCurrentMonthValue());
    } else if (mode !== 'customMonth') {
      setSelectedMonth('');
    }
    if (mode !== 'date' && mode !== 'customMonth') {
      setShowDatePicker(false);
    }
  };

  // Check if the active lead has already been submitted to IRS Logics
  const hasBeenSubmittedToIRSLogics = useMemo(() => {
    if (!activeLead || !leadActivities.length) return false;
    return leadActivities.some(
      (activity: any) => 
        activity.activity_type === 'irs_logics_submission' || 
        activity.type === 'irs_logics_submission' ||
        (activity.activity_type && activity.activity_type.toLowerCase() === 'irs_logics_submission')
    );
  }, [activeLead, leadActivities]);

  // BZ (Busy Signal) attempt count for current lead (from disposition_change activities)
  const bzAttemptCount = useMemo(() => {
    return (leadActivities || []).filter((a: any) => {
      if (a.activity_type !== 'disposition_change') return false;
      try {
        const m = typeof a.metadata === 'string' ? JSON.parse(a.metadata) : (a.metadata || {});
        return m.new_status === 'BZ (Busy Signal)';
      } catch {
        return false;
      }
    }).length;
  }, [leadActivities]);

  const handleSubmitToIRSLogics = async () => {
    if (!activeLead) {
      toast.warning('Please select a lead first.');
      return;
    }

    if (hasBeenSubmittedToIRSLogics) {
      toast.warning('This lead has already been submitted to IRS Logics.');
      return;
    }

    setIsSubmittingDisposition(true);
    try {
      console.log('[IRS Logics] Submitting lead to IRS Logics:', activeLead.id);
      
      const response = await fetch('/api/irs-logics', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          first_name: activeLead.first_name,
          last_name: activeLead.last_name,
          middle_name: activeLead.middle_name,
          email: activeLead.email,
          phone: activeLead.phone,
          address_line1: activeLead.address_line1,
          address_line2: activeLead.address_line2,
          city: activeLead.city,
          state: activeLead.state,
          postal_code: activeLead.postal_code,
          date_of_birth: activeLead.date_of_birth,
          lead_age: activeLead.lead_age,
          source: activeLead.source,
          status: activeLead.status,
          // Qualification / specification details (saved when user marks lead Qualified)
          estimated_debt: qualificationTaxDebt || (activeLead as any).estimated_debt,
          unfiled_years: qualificationTaxYear || (Array.isArray((activeLead as any).unfiled_years) ? (activeLead as any).unfiled_years.join(', ') : (activeLead as any).unfiled_years),
          tax_type: qualificationTaxType || ((activeLead as any).tags || []).find((t: string) => t.startsWith('TaxType:'))?.replace('TaxType:', ''),
        }),
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Failed to submit to IRS Logics');
      }

      console.log('[IRS Logics] Successfully submitted with 200 response:', result);
      
      // Only save to DB after successful 200 response from IRS Logics API
      // Update the disposition if "Qualified" is selected
      if (selectedDisposition === 'Qualified') {
        // Save the qualified disposition change to database
        await handleSubmitDisposition('Qualified', true);
        
        // Save activity for qualified status change (this happens inside handleSubmitDisposition)
        // Also save activity for IRS Logics submission
        await saveActivity(
          activeLead.id,
          'irs_logics_submission',
          'Lead submitted to IRS Logics',
          {
            irs_logics_response: result.data,
            status: 'Qualified',
          }
        );
      } else {
        // If not Qualified, just save the IRS Logics submission activity
        await saveActivity(
          activeLead.id,
          'irs_logics_submission',
          'Lead submitted to IRS Logics',
          {
            irs_logics_response: result.data,
          }
        );
      }

      // Refresh activities to update the hasBeenSubmittedToIRSLogics check
      if (activeLead?.id) {
        await fetchLeadActivities(activeLead.id);
      }

      // Show success message
      toast.success('Lead successfully submitted to IRS Logics!');
    } catch (error: any) {
      console.error('[IRS Logics] Error submitting to IRS Logics:', error);
      toast.error(`Failed to submit to IRS Logics: ${error.message || 'Unknown error'}`);
    } finally {
      setIsSubmittingDisposition(false);
    }
  };

  const handleSubmitDisposition = async (overrideDisposition?: string, fromIRSLogicsButton: boolean = false) => {
    if (!activeLead) return;

    const dispositionToUse = overrideDisposition || selectedDisposition;
    if (!dispositionToUse || dispositionToUse.trim() === '') {
      toast.warning('Please select a disposition before submitting.');
      return;
    }

    setIsSubmittingDisposition(true);
    try {
      // Get the current status from the database to ensure we have the latest
      const { data: currentLeadData, error: fetchError } = await supabase
        .from('leads')
        .select('status')
        .eq('id', activeLead.id)
        .single();

      if (fetchError) throw fetchError;

      const oldStatus = currentLeadData?.status || activeLead.status;
      let statusToSave = getPrimaryStatusValue(dispositionToUse);
      let bzAttemptNumber: number | undefined;
      let autoConvertedFromBz = false;

      // BZ (Busy Signal): track count from activities; 3rd BZ auto-converts to NW# (No Working Number)
      if (dispositionToUse === 'BZ (Busy Signal)') {
        const { data: bzActivities } = await supabase
          .from('lead_activities')
          .select('id, metadata')
          .eq('lead_id', activeLead.id)
          .eq('activity_type', 'disposition_change');
        const previousBzCount = (bzActivities || []).filter((a: any) => {
          try {
            const m = typeof a.metadata === 'string' ? JSON.parse(a.metadata) : (a.metadata || {});
            return m.new_status === 'BZ (Busy Signal)';
          } catch {
            return false;
          }
        }).length;
        const newBzCount = previousBzCount + 1;
        if (newBzCount >= 3) {
          statusToSave = 'NW# (No Working Number)';
          autoConvertedFromBz = true;
        } else {
          statusToSave = 'BZ (Busy Signal)';
          bzAttemptNumber = newBzCount;
        }
      }

      // Only proceed if status is actually changing (or BZ repeat for attempt counting, or IRSLogics during power dialing)
      const statusChanged = oldStatus !== statusToSave;
      const isBzRepeat = dispositionToUse === 'BZ (Busy Signal)'; // BZ can be submitted again for 2nd/3rd attempt
      const shouldUpdateAndLog = statusChanged || isBzRepeat;
      if (!shouldUpdateAndLog && !(fromIRSLogicsButton && isPowerDialing)) {
        if (!fromIRSLogicsButton) {
          toast.info('Status is already set to this value.');
        }
        if (!isPowerDialing || !fromIRSLogicsButton) {
          setIsSubmittingDisposition(false);
          return;
        }
      }

      // Update lead status and log activity (when status changed or when recording another BZ attempt)
      if (shouldUpdateAndLog) {
        const updates: any = { status: statusToSave };
        
        // If status is "Qualified", save qualification details
        if (statusToSave === 'Qualified' || statusToSave === 'Qualified Lead') {
          if (qualificationTaxDebt) updates.estimated_debt = parseFloat(qualificationTaxDebt);
          if (qualificationTaxYear) updates.unfiled_years = qualificationTaxYear.split(',').map(s => s.trim()).filter(s => s);
          if (qualificationTaxType) {
            const currentTags = activeLead.tags || [];
            const taxTypeTagPrefix = 'TaxType:';
            const newTags = currentTags.filter((t: string) => !t.startsWith(taxTypeTagPrefix));
            newTags.push(`${taxTypeTagPrefix}${qualificationTaxType}`);
            updates.tags = newTags;
          }
        }

        const { error } = await supabase
          .from('leads')
          .update(updates)
          .eq('id', activeLead.id);
        if (error) throw error;

        // Save activity for disposition change (only if status changed)
        const activityMetadata: any = {
          old_status: oldStatus,
          new_status: statusToSave,
          old_status_display: formatStatusForDisplay(oldStatus),
          new_status_display: formatStatusForDisplay(statusToSave),
        };
        if (bzAttemptNumber != null) activityMetadata.bz_attempt_number = bzAttemptNumber;
        if (autoConvertedFromBz) {
          activityMetadata.auto_converted_from_bz = true;
          activityMetadata.bz_attempt_count = 3;
        }

        // If qualified, add qualification details to metadata
        if (statusToSave === 'Qualified' || statusToSave === 'Qualified Lead') {
          if (qualificationTaxDebt) activityMetadata.estimated_debt = qualificationTaxDebt;
          if (qualificationTaxYear) activityMetadata.unfiled_years = qualificationTaxYear;
          if (qualificationTaxType) activityMetadata.tax_type = qualificationTaxType;
        }

        const activityDescription = autoConvertedFromBz
          ? `Auto-converted to NW# (No Working Number) after 3 BZ (Busy Signal) attempts`
          : `Status changed from "${formatStatusForDisplay(oldStatus)}" to "${formatStatusForDisplay(statusToSave)}"`;
        await saveActivity(
          activeLead.id,
          'disposition_change',
          activityDescription,
          activityMetadata
        );
        if (autoConvertedFromBz) {
          toast.info('Lead auto-converted to NW# (No Working Number) after 3 BZ attempts.');
        }

        // Update local state
        if (activeLead) {
          const updatedLead = { ...activeLead, status: statusToSave };
          updateLeadInState(updatedLead);

          // CRITICAL: Update the lead in powerDialingLeads array to keep it in sync
          // This ONLY updates the lead data, NEVER changes the array length or order
          // The powerDialingLeads array is a FIXED queue created at session start and remains independent
          if (isPowerDialing) {
            // Use the snapshot ref as the source of truth for the original length
            const snapshotLength = powerDialingQueueSnapshotRef.current.length;

            if (snapshotLength > 0) {
              setPowerDialingLeads(prevLeads => {
                const originalLength = prevLeads.length;

                // CRITICAL: If lengths don't match, something is wrong - restore from snapshot
                if (originalLength !== snapshotLength) {
                  console.error('CRITICAL ERROR: powerDialingLeads length mismatch! Restoring from snapshot.', {
                    stateLength: originalLength,
                    snapshotLength: snapshotLength,
                    leadId: activeLead.id,
                    status: statusToSave
                  });
                  // Restore from snapshot and then update the lead
                  const restored = [...powerDialingQueueSnapshotRef.current];
                  return restored.map(lead =>
                    lead.id === activeLead.id ? updatedLead : lead
                  );
                }

                const updated = prevLeads.map(lead =>
                  lead.id === activeLead.id ? updatedLead : lead
                );

                // CRITICAL SAFETY CHECK: Verify array length hasn't changed
                if (updated.length !== originalLength || updated.length !== snapshotLength) {
                  console.error('CRITICAL ERROR: powerDialingLeads array length changed after update!', {
                    before: originalLength,
                    after: updated.length,
                    snapshot: snapshotLength,
                    leadId: activeLead.id,
                    status: statusToSave
                  });
                  // Restore from snapshot to prevent corruption
                  const restored = [...powerDialingQueueSnapshotRef.current];
                  return restored.map(lead =>
                    lead.id === activeLead.id ? updatedLead : lead
                  );
                }

                console.log('✓ Updated lead in powerDialingLeads. Queue length remains:', updated.length, 'Lead ID:', activeLead.id);
                return updated;
              });
            }
          }
        }

        // Refresh leads list and activities
        // NOTE: This updates the main leads list, but powerDialingLeads remains independent
        // The snapshot ref is NEVER affected by fetchLeads()
        await fetchLeads();

        // CRITICAL: After fetchLeads(), verify powerDialingLeads hasn't been corrupted
        // This is a safety check to ensure the queue doesn't shrink
        if (isPowerDialing && powerDialingQueueSnapshotRef.current.length > 0) {
          const snapshotLength = powerDialingQueueSnapshotRef.current.length;
          // Use a small delay to check after state updates
          setTimeout(() => {
            if (powerDialingLeads.length !== snapshotLength) {
              console.error('CRITICAL: powerDialingLeads corrupted after fetchLeads! Restoring from snapshot.', {
                stateLength: powerDialingLeads.length,
                snapshotLength: snapshotLength
              });
              // Restore from snapshot to prevent queue from shrinking
              setPowerDialingLeads([...powerDialingQueueSnapshotRef.current]);
            }
          }, 100);
        }

        // Refresh activities to show the new disposition change
        await fetchLeadActivities(activeLead.id);
      }

      // Note: IRS Logics submission is now handled separately in handleSubmitToIRSLogics
      // This function only handles disposition changes to the database
      // When called with fromIRSLogicsButton=true, it means IRS Logics submission already succeeded

      // Power dialer behavior:
      // - Qualified: advance only when call has ended AND disposition saved (useEffect handles this; do nothing here).
      // - Non-qualified: advance immediately — end the call if still active so the dialer moves to next without waiting for End Call.
      const isQualifiedStatus = statusToSave === 'Qualified' || statusToSave === 'Qualified Lead';
      if (!isQualifiedStatus || fromIRSLogicsButton) {
        toast.success('Disposition saved successfully!');
      }

      if (isPowerDialing && !isQualifiedStatus) {
        const session = currentCall;
        if (session) {
          try {
            setWebPhoneStatus('Ending call...');
            const s = session as any;
            const sessionState = s.state || s.sessionState;
            if (sessionState === 'Initial' || sessionState === 'Establishing') {
              if (s.cancel) await s.cancel();
              else if (s.bye) await s.bye();
            } else {
              if (s.bye) await s.bye();
              else if (s.terminate) await s.terminate();
            }
          } catch (err) {
            console.error('Error ending call for power dialer advance:', err);
            setCurrentCall(null);
            currentCallRef.current = null;
            setCallStartTime(null);
            callJustEndedRef.current = true;
          }
        } else {
          callJustEndedRef.current = true;
          setPowerDialerAdvanceTrigger((t) => t + 1);
        }
      }
    } catch (err) {
      console.error('Failed to update disposition:', err);
      toast.error('Failed to update disposition. Please try again.');
    } finally {
      setIsSubmittingDisposition(false);
    }
  };

  const handleNewLeadChange = (field: keyof typeof newLead, value: string) => {
    setNewLead((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const handleCreateLead = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsCreatingLead(true);
    try {
      // Normalize phone number for comparison
      const normalizePhone = (phone: string | null | undefined): string => {
        if (!phone) return '';
        return phone.replace(/[\s\-\(\)\.]/g, '').trim();
      };

      const normalizedPhone = normalizePhone(newLead.phone);

      // Check for duplicate if phone number exists
      if (normalizedPhone) {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
          toast.error('You must be logged in to create leads.');
          setIsCreatingLead(false);
          return;
        }

        // Query for ALL existing leads with the same phone number
        // Fetch in batches to get all leads (Supabase has a 1000 row limit per query)
        let allExistingLeads: any[] = [];
        let page = 0;
        let hasMore = true;
        const pageSize = 1000;

        while (hasMore) {
          const from = page * pageSize;
          const to = from + pageSize - 1;

          const { data: pageLeads, error: queryError } = await supabase
            .from('leads')
            .select('id, phone, first_name, last_name, email')
            .eq('user_id', user.id)
            .range(from, to);

          if (queryError) throw queryError;

          if (pageLeads && pageLeads.length > 0) {
            allExistingLeads = [...allExistingLeads, ...pageLeads];
            hasMore = pageLeads.length === pageSize;
            page++;
          } else {
            hasMore = false;
          }
        }

        // Check if any existing lead has the same normalized phone number
        const isDuplicate = allExistingLeads.some(lead => {
          const existingNormalized = normalizePhone(lead.phone);
          return existingNormalized && existingNormalized === normalizedPhone;
        });

        if (isDuplicate) {
          const duplicateLead = allExistingLeads.find(lead => {
            const existingNormalized = normalizePhone(lead.phone);
            return existingNormalized && existingNormalized === normalizedPhone;
          });

          toast.warning(
            `This lead already exists! Existing: ${duplicateLead?.first_name} ${duplicateLead?.last_name} (${duplicateLead?.phone}). Leads are identified by phone number.`
          );
          setIsCreatingLead(false);
          return;
        }
      }

      const statusToSave = getPrimaryStatusValue(newLead.status);
      const payload = {
        ...newLead,
        status: statusToSave,
        tags: newLead.tags
          ? newLead.tags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean)
          : [],
      };

      const { error } = await supabase.from('leads').insert([payload]);
      if (error) throw error;

      setNewLead({ ...INITIAL_LEAD_FORM });
      setShowLeadModal(false);
      resetPaginationState();
      await fetchLeads();
      toast.success('Lead created successfully!');
    } catch (err) {
      console.error('Failed to create lead:', err);
      toast.error('Failed to create lead. Please try again.');
    } finally {
      setIsCreatingLead(false);
    }
  };

  const resetImportModal = () => {
    setShowImportModal(false);
    setPendingImportFile(null);
    setImportTags('Imported');
    setImportSource('CSV Import');
    setImportError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setPendingImportFile(file);
    setImportError(null);
  };

  const handleImportSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setImportError(null);
    if (!pendingImportFile) {
      setImportError('Please select a CSV file to import.');
      return;
    }

    setIsImporting(true);
    const normalizedTags = importTags
      ? importTags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean)
      : [];

    Papa.parse(pendingImportFile, {
      header: true,
      skipEmptyLines: true,
      complete: async (results) => {
        try {
          const {
            data: { user },
          } = await supabase.auth.getUser();
          if (!user) {
            toast.error('You must be logged in to upload leads.');
            setIsImporting(false);
            return;
          }

          const finalTags = normalizedTags.length ? normalizedTags : ['Imported'];

          const parsedLeads = results.data.map((row: any) => ({
            user_id: user.id,
            first_name: row['First Name'] || '',
            last_name: row['Last Name'] || '',
            middle_name: row['Middle Name'] || null,
            email: row['Email'] || null,
            phone: row['Phone'] || null,
            address_line1: row['Address'] || null,
            address_line2: row['Address 2'] || null,
            city: row['City'] || null,
            state: row['State'] || null,
            postal_code: row['Zip'] || null,
            ip_address: row['IP Address'] || null,
            date_of_birth: row['Date of Birth']
              ? new Date(row['Date of Birth']).toISOString().split('T')[0]
              : null,
            lead_age: row['Lead Age']
              ? new Date(row['Lead Age']).toISOString().split('T')[0]
              : null,
            fulfill_date: row['fulfill_date']
              ? new Date(row['fulfill_date']).toISOString()
              : null,
            status:
              row['Status']?.trim()
                ? getPrimaryStatusValue(
                  getDisplayStatusFromDb(row['Status']?.trim()) || 'New'
                )
                : 'New',
            source:
              row['Source']?.trim() || importSource || 'CSV Import',
            tags: finalTags,
            created_at: new Date().toISOString(),
          }));

          if (parsedLeads.length === 0) {
            setImportError('The CSV file appears to be empty.');
            setIsImporting(false);
            return;
          }

          // Normalize phone numbers for comparison (remove spaces, dashes, parentheses, etc.)
          const normalizePhone = (phone: string | null | undefined): string => {
            if (!phone) return '';
            return phone.replace(/[\s\-\(\)\.]/g, '').trim();
          };

          // Filter out leads without phone numbers for duplicate check
          const leadsWithPhone = parsedLeads.filter(lead => lead.phone && normalizePhone(lead.phone));
          
          if (leadsWithPhone.length > 0) {
            // Get all phone numbers from the CSV
            const csvPhoneNumbers = leadsWithPhone.map(lead => normalizePhone(lead.phone));
            
            // Query database for ALL existing leads with these phone numbers
            // Fetch in batches to get all leads (Supabase has a 1000 row limit per query)
            let allExistingLeads: any[] = [];
            let page = 0;
            let hasMore = true;
            const pageSize = 1000;

            while (hasMore) {
              const from = page * pageSize;
              const to = from + pageSize - 1;

              const { data: pageLeads, error: queryError } = await supabase
                .from('leads')
                .select('id, phone, first_name, last_name, email')
                .eq('user_id', user.id)
                .range(from, to);

              if (queryError) throw queryError;

              if (pageLeads && pageLeads.length > 0) {
                allExistingLeads = [...allExistingLeads, ...pageLeads];
                hasMore = pageLeads.length === pageSize;
                page++;
              } else {
                hasMore = false;
              }
            }

            console.log(`[Duplicate Check] Fetched ${allExistingLeads.length} existing leads from database for comparison`);

            // Normalize existing phone numbers and create a map
            const existingPhoneMap = new Map<string, any>();
            allExistingLeads.forEach(lead => {
              const normalized = normalizePhone(lead.phone);
              if (normalized) {
                existingPhoneMap.set(normalized, lead);
              }
            });

            // Separate duplicates from new leads
            const duplicateLeadsList: any[] = [];
            const newLeads: any[] = [];

            parsedLeads.forEach(lead => {
              const normalizedPhone = normalizePhone(lead.phone);
              if (normalizedPhone && existingPhoneMap.has(normalizedPhone)) {
                // This is a duplicate
                const existingLead = existingPhoneMap.get(normalizedPhone);
                duplicateLeadsList.push({
                  csvLead: {
                    first_name: lead.first_name,
                    last_name: lead.last_name,
                    phone: lead.phone,
                    email: lead.email,
                  },
                  existingLead: existingLead,
                });
              } else {
                // This is a new lead (either no phone or phone doesn't exist)
                newLeads.push(lead);
              }
            });

            // If there are duplicates, show the modal
            if (duplicateLeadsList.length > 0) {
              setDuplicateLeads(duplicateLeadsList);
              setShowDuplicateModal(true);
            }

            // Only insert non-duplicate leads
            if (newLeads.length > 0) {
              const { error } = await supabase.from('leads').insert(newLeads);
              if (error) throw error;
            }

            // Show success message with details
            if (duplicateLeadsList.length > 0 && newLeads.length > 0) {
              toast.success(`Successfully imported ${newLeads.length} new leads. ${duplicateLeadsList.length} duplicate lead(s) were skipped (see details in popup).`);
            } else if (duplicateLeadsList.length > 0 && newLeads.length === 0) {
              toast.info(`All ${duplicateLeadsList.length} lead(s) were duplicates. No new leads were imported (see details in popup).`);
            } else {
              toast.success(`Successfully imported ${newLeads.length} leads!`);
            }

            resetPaginationState();
            await fetchLeads();
            
            // Only close import modal if there are no duplicates, otherwise keep it open to show duplicate modal
            if (duplicateLeadsList.length === 0) {
              resetImportModal();
            }
          } else {
            // No phone numbers in CSV, insert all leads
            const { error } = await supabase.from('leads').insert(parsedLeads);
            if (error) throw error;

            toast.success(`Successfully imported ${parsedLeads.length} leads!`);
            resetPaginationState();
            await fetchLeads();
            resetImportModal();
          }
        } catch (err: any) {
          console.error('Error uploading leads:', err);
          setImportError(err.message || 'Failed to import leads.');
        } finally {
          setIsImporting(false);
        }
      },
      error: (error) => {
        console.error('CSV Parse Error:', error);
        setImportError('Failed to parse CSV file.');
        setIsImporting(false);
      },
    });
  };

  const handleBulkDelete = async () => {
    showConfirmation(
      `Are you sure you want to delete leads with status: ${deleteStatusFilter}? This action cannot be undone.`,
      async () => {
        setIsDeleting(true);
        try {
          const { data: { session } } = await supabase.auth.getSession();
          if (!session) {
            toast.error('You must be logged in to delete leads');
            setIsDeleting(false);
            return;
          }

          const response = await fetch('/api/leads/delete', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({ statusFilter: deleteStatusFilter }),
          });

          const data = await response.json();

          if (!response.ok) {
            throw new Error(data.error || 'Failed to delete leads');
          }

          setShowDeleteModal(false);
          setDeleteStatusFilter('All');
          resetPaginationState();
          await fetchLeads();
          toast.success('Leads deleted successfully');
        } catch (err: unknown) {
          console.error('Error deleting leads:', err);
          toast.error(err instanceof Error ? err.message : 'Failed to delete leads');
        } finally {
          setIsDeleting(false);
        }
      }
    );
  };

  const updateLeadInState = (updatedLead: Lead) => {
    setActiveLead(updatedLead);
    setLeads(prev =>
      prev.map(lead => (lead.id === updatedLead.id ? updatedLead : lead))
    );
  };

  const handleAddTag = async () => {
    if (!activeLead) return;
    const newTag = newTagValue.trim();
    if (!newTag) return;
    setIsTagSaving(true);
    try {
      const updatedTags = Array.from(
        new Set([...(activeLead.tags || []), newTag])
      );

      const { error } = await supabase
        .from('leads')
        .update({ tags: updatedTags })
        .eq('id', activeLead.id);

      if (error) throw error;

      updateLeadInState({ ...activeLead, tags: updatedTags });
      setNewTagValue('');
      setShowTagInput(false);
    } catch (err) {
      console.error('Failed to add tag:', err);
      toast.error('Failed to add tag. Please try again.');
    } finally {
      setIsTagSaving(false);
    }
  };

  const handleRemoveTag = async (tagToRemove: string) => {
    if (!activeLead) return;
    setIsTagSaving(true);
    try {
      const updatedTags = (activeLead.tags || []).filter(
        (tag) => tag.toLowerCase() !== tagToRemove.toLowerCase()
      );

      const { error } = await supabase
        .from('leads')
        .update({ tags: updatedTags })
        .eq('id', activeLead.id);

      if (error) throw error;

      updateLeadInState({ ...activeLead, tags: updatedTags });
    } catch (err) {
      console.error('Failed to remove tag:', err);
      toast.error('Failed to remove tag. Please try again.');
    } finally {
      setIsTagSaving(false);
    }
  };

  const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !isTagSaving) {
      e.preventDefault();
      handleAddTag();
    }
  };

  const totalPages = Math.ceil(totalLeads / itemsPerPage);

  const getPageNumbers = () => {
    // If using cursor pagination and we are deep in pages (e.g. page > 1),
    // random access is restricted. But for simplicity in UI, we will just show
    // simple Next/Prev if sorting is default (Cursor mode), or standard if not.

    // However, to keep UI consistent, let's keep the numbers but disable them 
    // or rely on the hybrid approach where clicking them triggers offset fetch.

    const pages = [];
    const maxVisiblePages = 5;

    if (totalPages <= maxVisiblePages) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      if (currentPage <= 3) {
        for (let i = 1; i <= 5; i++) pages.push(i);
      } else if (currentPage >= totalPages - 2) {
        for (let i = totalPages - 4; i <= totalPages; i++) pages.push(i);
      } else {
        for (let i = currentPage - 2; i <= currentPage + 2; i++) pages.push(i);
      }
    }
    return pages;
  };

  const getSortIcon = (key: string) => {
    if (sortConfig?.key === key) {
      return sortConfig.direction === 'asc'
        ? <i className="fa-solid fa-sort-up ml-2 text-blue-600"></i>
        : <i className="fa-solid fa-sort-down ml-2 text-blue-600"></i>;
    }
    return <i className="fa-solid fa-sort ml-2 opacity-0 group-hover:opacity-100 transition-opacity"></i>;
  };

  const getInitials = (first: string, last: string) => {
    return `${first?.charAt(0) || ''}${last?.charAt(0) || ''}`.toUpperCase();
  };

  const getTimeAgo = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (seconds < 60) return 'Just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} mins ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hours ago`;
    const days = Math.floor(hours / 24);
    return `${days} days ago`;
  };

  return (
    <>
      {/* Confirmation Modal */}
      {confirmationModal.show && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4">
          {/* Backdrop */}
          <div 
            className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            onClick={() => setConfirmationModal({ ...confirmationModal, show: false })}
          ></div>
          
          {/* Modal */}
          <div className="relative bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 transform transition-all">
            <div className="flex items-start gap-4 mb-6">
              <div className="flex-shrink-0 w-12 h-12 rounded-full bg-red-100 flex items-center justify-center">
                <i className="fa-solid fa-exclamation-triangle text-red-600 text-xl"></i>
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-bold text-slate-900 mb-2">Confirm Action</h3>
                <p className="text-sm text-slate-600">{confirmationModal.message}</p>
              </div>
            </div>
            
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => {
                  setConfirmationModal({ ...confirmationModal, show: false });
                  if (confirmationModal.onCancel) {
                    confirmationModal.onCancel();
                  }
                }}
                className="px-6 py-2.5 rounded-xl text-sm font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  setConfirmationModal({ ...confirmationModal, show: false });
                  await confirmationModal.onConfirm();
                }}
                className="px-6 py-2.5 rounded-xl text-sm font-semibold text-white bg-red-600 hover:bg-red-700 transition-colors"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="bg-[#F8FAFC] text-slate-900 h-screen overflow-hidden flex" style={{ 
        fontFamily: "var(--font-geist-sans), 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        WebkitFontSmoothing: 'antialiased',
        MozOsxFontSmoothing: 'grayscale',
        textRendering: 'optimizeLegibility'
      }}>
        <style>{`
          /* Enterprise Design System - Stable & Premium */
        :root {
          --p-indigo: #4F46E5;
          --p-indigo-soft: #EEF2FF;
          --p-emerald: #10B981;
          --p-slate-50: #F8FAFC;
          --p-slate-100: #F1F5F9;
          --p-slate-200: #E2E8F0;
          --p-slate-800: #1E293B;
          --p-slate-900: #0F172A;
          --card-radius: 24px;
        }

        .dashboard-card {
          background: #ffffff;
          border: 1px solid var(--p-slate-200);
          border-radius: var(--card-radius);
          box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.05), 0 1px 2px -1px rgba(0, 0, 0, 0.05);
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .dashboard-card:hover {
          border-color: rgba(79, 70, 229, 0.3);
          box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
          transform: translateY(-2px);
        }

        .stats-card {
          padding: 28px;
          display: flex;
          flex-direction: column;
          gap: 14px;
          position: relative;
          overflow: hidden;
        }

        .stats-card::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 3px;
          background: linear-gradient(90deg, transparent, var(--p-indigo), transparent);
          opacity: 0;
          transition: opacity 0.3s ease;
        }

        .stats-card:hover::before {
          opacity: 1;
        }

        .stats-icon {
          width: 44px;
          height: 44px;
          border-radius: 12px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 18px;
          flex-shrink: 0;
        }

        .stats-icon i {
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .chart-panel {
          padding: 24px;
          height: 100%;
          display: flex;
          flex-direction: column;
        }

        .active-stream-item {
          padding: 16px;
          border-radius: 16px;
          background: #ffffff;
          border: 1px solid var(--p-slate-100);
          transition: all 0.2s ease;
        }

        .active-stream-item:hover {
          background: var(--p-slate-50);
          border-color: var(--p-indigo);
          transform: translateX(4px);
        }

        .status-badge {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.06em;
          padding: 5px 10px;
          line-height: 1.4;
          -webkit-font-smoothing: antialiased;
          border-radius: 6px;
          text-transform: uppercase;
        }

        .nav-link {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 16px;
          border-radius: 12px;
          font-size: 14px;
          font-weight: 600;
          line-height: 1.5;
          letter-spacing: -0.01em;
          transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
          color: #94A3B8;
          position: relative;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
        }

        .nav-link:hover {
          background: rgba(255, 255, 255, 0.08);
          color: #ffffff;
          transform: translateX(2px);
        }

        .nav-link.active {
          background: linear-gradient(135deg, var(--p-indigo) 0%, #4338CA 100%);
          color: #ffffff;
          box-shadow: 0 4px 16px rgba(79, 70, 229, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.1) inset;
        }

        .nav-link.active::before {
          content: '';
          position: absolute;
          left: 0;
          top: 50%;
          transform: translateY(-50%);
          width: 3px;
          height: 60%;
          background: #ffffff;
          border-radius: 0 2px 2px 0;
        }

        .btn-premium {
          transition: all 0.2s ease;
          font-weight: 700;
          letter-spacing: -0.01em;
        }

        .btn-premium:active {
          transform: scale(0.98);
        }

        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .animate-fade-in {
          animation: fadeIn 0.4s ease-out forwards;
        }
      `}</style>

        {/* Video elements for WebRTC - Always in DOM for WebPhone initialization */}
        {/* These must be available before WebPhone initializes */}
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          style={{ display: 'none', position: 'absolute', width: '1px', height: '1px', top: '-9999px' }}
        />
        <video
          ref={localVideoRef}
          muted
          autoPlay
          playsInline
          style={{ display: 'none', position: 'absolute', width: '1px', height: '1px', top: '-9999px' }}
        />

        {/* Mobile Sidebar Overlay */}
        {isSidebarOpen && (
          <div 
            className="fixed inset-0 bg-slate-900/50 z-40 lg:hidden backdrop-blur-sm"
            onClick={() => setIsSidebarOpen(false)}
          ></div>
        )}

        {/* 1. LEFT NAVIGATION (SLIMMER & MORE MODERN) */}
        <aside className={`fixed inset-y-0 left-0 z-50 w-64 h-screen bg-gradient-to-b from-slate-950 to-slate-900 text-white flex flex-col shrink-0 min-h-0 border-r border-white/10 shadow-xl transform transition-transform duration-300 lg:translate-x-0 lg:static lg:inset-auto ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
          <div className="h-20 flex items-center px-6 mb-6 border-b border-white/5">
            <div className="flex items-baseline gap-1.5">
              <span className="font-black tracking-tight text-base leading-tight" style={{ letterSpacing: '-0.01em' }}>Integrated</span>
              <span className="font-bold text-blue-400 text-base tracking-tight" style={{ letterSpacing: '-0.01em' }}>Financial</span>
            </div>
            <button 
              onClick={() => setIsSidebarOpen(false)}
              className="ml-auto lg:hidden text-slate-400 hover:text-white"
            >
              <i className="fa-solid fa-times"></i>
            </button>
          </div>

          <nav className="px-3 space-y-1">
            <button
              onClick={() => { setActiveView('overview'); setIsSidebarOpen(false); }}
              className={`nav-link w-full ${activeView === 'overview' ? 'active' : ''}`}
            >
              <i className="fa-solid fa-house-chimney w-5 flex items-center justify-center"></i>
              <span>Dashboard</span>
            </button>

            <button
              onClick={() => { setActiveView('contacts'); setIsSidebarOpen(false); }}
              className={`nav-link w-full ${activeView === 'contacts' ? 'active' : ''}`}
            >
              <i className="fa-solid fa-users w-5 flex items-center justify-center"></i>
              <span>CRM Contacts</span>
            </button>

            {(hasOpenedContact || powerDialerEnabled || isPowerDialing) && (
              <button
                onClick={() => { setActiveView('dialer'); setIsSidebarOpen(false); }}
                className={`nav-link w-full ${activeView === 'dialer' ? 'active' : ''}`}
              >
                <i className="fa-solid fa-bolt w-5 flex items-center justify-center"></i>
                <span>Power Dialer</span>
              </button>
            )}

            {isPowerDialing && activeView !== 'dialer' && (
              <button
                onClick={() => { setActiveView('dialer'); setIsSidebarOpen(false); }}
                className="nav-link w-full text-amber-400 hover:text-amber-300 hover:bg-amber-500/10"
              >
                <i className="fa-solid fa-arrow-left w-5 flex items-center justify-center"></i>
                <span>Back to Power Dialer</span>
              </button>
            )}

            {userIsAdmin && (
              <button
                onClick={() => {
                  console.log('Settings button clicked, setting activeView to settings');
                  setActiveView('settings');
                  setIsSidebarOpen(false);
                }}
                className={`nav-link w-full ${activeView === 'settings' ? 'active' : ''}`}
              >
                <i className="fa-solid fa-gear w-5 flex items-center justify-center"></i>
                <span>Settings</span>
              </button>
            )}

          </nav>
          {/* <a href="#" className="flex items-center space-x-3 px-3 py-2 text-slate-400 hover:bg-white/5 hover:text-white rounded-xl transition-all">
            <i className="fa-solid fa-layer-group w-5 text-sm"></i> <span className="font-medium text-sm">Pipelines</span>
          </a>
          <a href="#" className="flex items-center space-x-3 px-3 py-2 text-slate-400 hover:bg-white/5 hover:text-white rounded-xl transition-all">
            <i className="fa-solid fa-calendar-check w-5 text-sm"></i> <span className="font-medium text-sm">Appointments</span>
          </a> */}
          {/* <a href="#" className="flex items-center space-x-3 px-3 py-2 text-slate-400 hover:bg-white/5 hover:text-white rounded-xl">
            <i className="fa-solid fa-chart-column w-5 text-sm"></i> <span className="font-medium text-sm">Reporting</span>
          </a> */}

          {/* Queue Section (Only in Dialer View) */}
          {activeView === 'dialer' && (() => {
            let queueLeads: Lead[] = [];
            let activeIdx = -1;

            if (isPowerDialing) {
              // CRITICAL: Use the IMMUTABLE snapshot from ref for Live Queue display
              // This ensures the queue length never changes, even if state is updated
              queueLeads = powerDialingQueueSnapshotRef.current.length > 0
                ? powerDialingQueueSnapshotRef.current
                : powerDialingLeads; // Fallback to state if ref is empty
              activeIdx = powerDialingIndex;
              console.log('Live Queue: Using snapshot. Length:', queueLeads.length, 'Active index:', activeIdx);
            } else {
              const needsDisposition = (lead: Lead) => {
                const status = lead.status || 'New';
                return !PROCESSED_STATUS_DB_VALUES.includes(status);
              };
              queueLeads = leads.filter(needsDisposition);
              activeIdx = activeLead ? queueLeads.findIndex(l => l.id === activeLead.id) : -1;
            }

            const activeItem = activeIdx >= 0 ? queueLeads[activeIdx] : (activeView === 'dialer' ? activeLead : null);
            const remainingCount = Math.max(0, queueLeads.length - (activeIdx >= 0 ? activeIdx + 1 : (activeItem ? 1 : 0)));
            const historyLeads = activeIdx > 0 ? queueLeads.slice(Math.max(0, activeIdx - 2), activeIdx) : [];

            // Get next items, but exclude the active lead if it's not in the queue (to avoid duplicates)
            let nextItems: Lead[] = [];
            if (activeIdx >= 0) {
              // Active lead is in queue, get items after it
              nextItems = queueLeads.slice(activeIdx + 1, activeIdx + 6);
            } else {
              // Active lead is not in queue, get first 5 but exclude activeLead if it exists
              nextItems = queueLeads
                .filter(lead => !activeLead || lead.id !== activeLead.id)
                .slice(0, 5);
            }

            // Only show Live Queue when power dialing is active
            if (!isPowerDialing) {
              return null;
            }

            return (
              <div className="mt-8 px-4 flex-1 min-h-0 overflow-y-auto no-scrollbar">
                <div className="flex items-center justify-between px-3 mb-6">
                  <div className="flex items-center gap-2">
                    <span className="text-xs uppercase font-bold tracking-wide text-slate-400">Live Queue</span>
                  </div>
                  <span className="text-xs bg-slate-800 text-blue-400 px-2.5 py-1 rounded-md font-bold border border-white/5">
                    {remainingCount} REMAINING
                  </span>
                </div>

                <div className="space-y-6">
                  {/* History (Past items) */}
                  {historyLeads.length > 0 && (
                    <div className="space-y-2 opacity-30">
                      {historyLeads.map((lead) => (
                        <div key={lead.id} className="px-3 py-2 rounded-lg border border-white/5 bg-white/5">
                          <p className="text-xs font-mono text-slate-400 tracking-tight">{lead.phone}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Active Item */}
                  {activeItem && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 px-3">
                        <span className="text-xs font-extrabold uppercase tracking-wide text-blue-500">Active Session</span>
                        <div className="h-px bg-blue-500/20 flex-1"></div>
                      </div>
                      <div className="bg-gradient-to-br from-blue-600 to-indigo-700 p-4 rounded-2xl shadow-lg shadow-blue-900/40 border border-blue-400/20 relative overflow-hidden group">
                        <div className="absolute top-0 right-0 p-2 opacity-20">
                          <i className="fa-solid fa-signal text-white animate-pulse"></i>
                        </div>
                        <div className="relative z-10">
                          <h4 className="text-white font-bold text-sm mb-1">{activeItem.first_name} {activeItem.last_name}</h4>
                          <p className="text-blue-100 font-mono text-xs tracking-wider">{activeItem.phone}</p>
                        </div>
                        <div className="mt-3 flex items-center gap-2">
                          <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-ping"></div>
                          <span className="text-xs text-blue-100 font-bold uppercase tracking-wide">In Progress</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Next Items */}
                  {nextItems.length > 0 && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 px-3 pt-2">
                        <span className="text-xs font-extrabold uppercase tracking-wide text-slate-500">Next</span>
                        <div className="h-px bg-white/5 flex-1"></div>
                      </div>
                      <div className="space-y-2">
                        {nextItems.map((lead, idx) => (
                          <div
                            key={lead.id}
                            className="group p-3 rounded-xl border border-white/5 bg-white/[0.02] hover:bg-white/[0.05] transition-all cursor-pointer"
                            onClick={() => {
                              if (!isPowerDialing) {
                                setActiveLead(lead);
                                setActiveView('dialer');
                              }
                            }}
                          >
                            <div className="flex justify-between items-center">
                              <div>
                                <h5 className="text-sm font-semibold text-slate-200 group-hover:text-white transition-colors leading-tight">
                                  {lead.first_name} {lead.last_name}
                                </h5>
                                <p className="text-xs text-slate-500 font-mono mt-1 group-hover:text-slate-400 tracking-tight">{lead.phone}</p>
                              </div>
                              <div className="text-[10px] text-slate-600 font-bold">#{activeIdx + idx + 2}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Logout Button - Bottom of Sidebar */}
          <div className="mt-auto p-4 border-t border-white/10 bg-slate-900/50">
            <button
              onClick={() => {
                showConfirmation('Are you sure you want to log out?', async () => {
                  try {
                    await supabase.auth.signOut();
                    router.push('/login');
                  } catch (error) {
                    console.error('Error signing out:', error);
                    toast.error('Failed to sign out. Please try again.');
                  }
                });
              }}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-red-400 hover:text-red-300 hover:bg-red-500/10 border border-red-500/20 transition-all hover:border-red-500/40 hover:shadow-lg hover:shadow-red-500/10"
            >
              <i className="fa-solid fa-right-from-bracket w-5 flex items-center justify-center"></i>
              <span className="font-semibold">Logout</span>
            </button>
          </div>
        </aside>

        {/* VIEW: OVERVIEW */}
        {activeView === 'overview' && (
          <main className="flex-1 p-6 lg:p-10 overflow-y-auto bg-[#F8FAFC]">
            <header className="max-w-7xl mx-auto mb-8">
              <div className="flex items-start justify-between gap-4 mb-3">
                <nav className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-wide text-slate-400">
                  <button 
                    onClick={() => setIsSidebarOpen(true)}
                    className="lg:hidden mr-2 text-slate-600 hover:text-slate-900"
                  >
                    <i className="fa-solid fa-bars text-lg"></i>
                  </button>
                  <span className="text-indigo-600">Integrated Financial</span>
                </nav>
                {userIsAdmin && (
                  <div className="flex items-center gap-3">
                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wide">View Stats For:</label>
                    <select
                      value={selectedUserId || 'all'}
                      onChange={(e) => setSelectedUserId(e.target.value === 'all' ? null : e.target.value)}
                      className="px-4 py-2 rounded-xl bg-white border border-slate-200 text-sm font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 cursor-pointer"
                    >
                      <option value="all">All Users</option>
                      {organizationUsers.map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.name || user.email}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              <h1 className="text-4xl lg:text-5xl font-black tracking-tight text-slate-900 leading-tight mb-2" style={{ letterSpacing: '-0.04em' }}>
                Dashboard
                {userIsAdmin && selectedUserId && (
                  <span className="text-lg font-semibold text-slate-500 ml-3">
                    - {organizationUsers.find(u => u.id === selectedUserId)?.name || organizationUsers.find(u => u.id === selectedUserId)?.email || 'User'}
                  </span>
                )}
              </h1>
              <p className="text-sm lg:text-base text-slate-500 font-medium leading-relaxed max-w-2xl" style={{ letterSpacing: '-0.01em' }}>Real-time operational intelligence & analytics</p>
            </header>

            <div className="max-w-7xl mx-auto space-y-6">
              {/* TOP KPIs */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <MetricCard
                  title="Total Leads"
                  value={metrics.totalLeads.toLocaleString()}
                  subtext="All leads"
                  icon="fa-database"
                  trend={{ value: metrics.growth, positive: metrics.growth >= 0 }}
                  colorClass="bg-indigo-50 text-indigo-600"
                />
                <MetricCard
                  title="New Leads Today"
                  value={metrics.todayCount}
                  subtext="Added today"
                  icon="fa-bolt"
                  colorClass="bg-blue-50 text-blue-600"
                />
                <MetricCard
                  title="Calls Today"
                  value={metrics.callsToday}
                  subtext="Calls made today"
                  icon="fa-headset"
                  colorClass="bg-emerald-50 text-emerald-600"
                />
                <MetricCard
                  title="Avg Call Duration"
                  value={metrics.avgDuration > 0 ? `${Math.floor(metrics.avgDuration / 60)}m ${metrics.avgDuration % 60}s` : '0s'}
                  subtext="Average call time"
                  icon="fa-clock"
                  colorClass="bg-amber-50 text-amber-600"
                />
              </div>

              {/* ANALYTICS SECTION */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch pb-8">
                <div className="lg:col-span-6">
                  <FunnelAnatomy metrics={metrics} />
                </div>
                <div className="lg:col-span-6">
                  <IntelligenceHeatmap data={metrics.activityHeatmap} />
                </div>
              </div>
            </div>
          </main>
        )}

        {/* VIEW: DIALER */}
        {
          activeView === 'dialer' && (
            <>
              {/* 2. MAIN LEAD AREA */}
              <main className="flex-1 flex flex-col bg-white overflow-hidden">
                {/* Modern Header - Hidden on mobile in Dialer view to give more space to call widget */}
                <header className="h-20 border-b border-slate-100 bg-white/50 backdrop-blur-sm hidden lg:flex items-center justify-between px-4 lg:px-8 shrink-0 shadow-sm">
                  <div className="flex items-center gap-5">
                    <button 
                      onClick={() => setIsSidebarOpen(true)}
                      className="lg:hidden text-slate-600 hover:text-slate-900"
                    >
                      <i className="fa-solid fa-bars text-lg"></i>
                    </button>
                    <div className="relative">
                      <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center text-white font-bold text-xl shadow-lg shadow-blue-200/50 ring-2 ring-blue-100">
                        {getInitials(activeLead?.first_name || '', activeLead?.last_name || '')}
                      </div>
                      {/* <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-white rounded-full flex items-center justify-center shadow-sm">
                    <i className="fa-brands fa-facebook text-blue-600 text-[10px]"></i>
                  </div> */}
                    </div>
                    <div className="hidden sm:block">
                      <h1 className="text-xl font-bold text-slate-900 tracking-tight">
                        {activeLead ? `${activeLead.first_name} ${activeLead.last_name}` : 'Select a Lead'}
                      </h1>
                      <div className="flex items-center gap-3 mt-1.5">
                        <span className="text-xs font-semibold text-slate-500 flex items-center gap-1">
                          <i className="fa-solid fa-location-dot text-xs"></i>
                          {activeLead?.city ? `${activeLead.city}, ${activeLead.state || ''}` : 'Unknown Location'}
                        </span>
                        <div className="h-1 w-1 rounded-full bg-slate-300"></div>
                        <span className="px-2 py-0.5 rounded-md bg-amber-50 text-amber-700 text-[10px] font-bold border border-amber-200/50">
                          {formatStatusForDisplay(activeLead?.status)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    {isPowerDialing && (
                      <button
                        onClick={() => startPowerDialing()}
                        className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-xl text-xs font-bold flex items-center gap-2 transition-all shadow-lg text-white"
                        title="Stop Power Dialer"
                      >
                        <i className="fa-solid fa-stop"></i>
                        <span className="hidden sm:inline">Stop Power Dialer</span>
                      </button>
                    )}
                  </div>
                </header>

                <div className="flex-1 flex flex-col lg:flex-row overflow-hidden relative lg:static">
                  {/* Mobile Call Widget Overlay - REMOVED (Merged into Right Panel) */}
                  
                  {/* Details Column - Hidden on mobile when using dialer view as full screen right panel handles it */}
                  <div className="hidden lg:block w-full lg:w-[380px] p-4 lg:p-8 overflow-y-auto border-b lg:border-b-0 lg:border-r border-slate-50 max-h-[40vh] lg:max-h-none">
                    <section className="mb-8">
                      <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-[0.2em] mb-6">Primary Information</h3>
                      <div className="space-y-6">
                        <div className="group cursor-pointer">
                          <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1 transition-colors group-hover:text-blue-600">Mobile Phone</label>
                          <div className="flex items-center justify-between text-slate-900 font-semibold border-b border-slate-100 pb-2 group-hover:border-blue-200 transition-all">
                            <span>{activeLead?.phone || '--'}</span>
                            <i className="fa-solid fa-copy text-slate-300 text-xs"></i>
                          </div>
                        </div>
                        <div>
                          <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Email Address</label>
                          <div className="text-slate-900 font-medium border-b border-slate-100 pb-2">{activeLead?.email || '--'}</div>
                        </div>
                        <div>
                          <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Source</label>
                          <div className="inline-flex items-center px-2 py-1 rounded bg-slate-100 text-[11px] font-bold text-slate-600 border border-slate-200">
                            {activeLead?.source || 'MANUAL'}
                          </div>
                        </div>
                        {/* CSV Details */}
                        {activeLead?.address_line1 && (
                          <div>
                            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Address</label>
                            <div className="text-slate-900 font-medium border-b border-slate-100 pb-2">
                              {activeLead.address_line1}
                              {activeLead.address_line2 && <span className="block text-xs text-slate-500">{activeLead.address_line2}</span>}
                              <span className="block text-xs text-slate-500">
                                {activeLead.city}, {activeLead.state} {activeLead.postal_code}
                              </span>
                            </div>
                          </div>
                        )}

                        <div className="grid grid-cols-2 gap-4">
                          {activeLead?.lead_age && (
                            <div>
                              <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Lead Age</label>
                              <div className="text-slate-900 font-medium border-b border-slate-100 pb-2">{activeLead.lead_age}</div>
                            </div>
                          )}
                          {activeLead?.date_of_birth && (
                            <div>
                              <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Date of Birth</label>
                              <div className="text-slate-900 font-medium border-b border-slate-100 pb-2">{activeLead.date_of_birth}</div>
                            </div>
                          )}
                        </div>

                        {activeLead?.ip_address && (
                          <div>
                            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">IP Address</label>
                            <div className="text-slate-900 font-medium border-b border-slate-100 pb-2 font-mono text-xs">{activeLead.ip_address}</div>
                          </div>
                        )}
                      </div>
                    </section>

                    <section>
                      <div className="flex items-center justify-between mb-4">
                        <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-[0.2em]">Marketing Tags</h3>
                        <button
                          type="button"
                          onClick={() =>
                            setShowTagInput((prev) => {
                              if (prev) setNewTagValue('');
                              return !prev;
                            })
                          }
                          className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-600 flex items-center gap-1 hover:text-blue-800"
                        >
                          <i className="fa-solid fa-plus text-xs"></i> Tag
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {activeLead?.tags && activeLead.tags.length > 0 ? (
                          activeLead.tags.map((tag, i) => (
                            <div
                              key={`${tag}-${i}`}
                              className="flex items-center gap-1 px-3 py-1 bg-blue-50 text-blue-700 text-[11px] font-bold rounded-lg border border-blue-100 uppercase"
                            >
                              <span>{tag}</span>
                              <button
                                type="button"
                                disabled={isTagSaving}
                                onClick={() => handleRemoveTag(tag)}
                                className="text-blue-500 hover:text-blue-800 disabled:opacity-50"
                                title="Remove tag"
                              >
                                <i className="fa-solid fa-xmark text-xs"></i>
                              </button>
                            </div>
                          ))
                        ) : (
                          <span className="text-xs text-slate-400 italic">No tags</span>
                        )}
                      </div>
                      {showTagInput && (
                        <div className="mt-4 flex gap-2">
                          <input
                            type="text"
                            value={newTagValue}
                            onChange={(e) => setNewTagValue(e.target.value)}
                            onKeyDown={handleTagKeyDown}
                            placeholder="Enter new tag"
                            className="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:ring-2 focus:ring-blue-100 outline-none"
                          />
                          <button
                            type="button"
                            onClick={handleAddTag}
                            disabled={isTagSaving}
                            className="px-4 py-2 rounded-xl bg-blue-600 text-white text-xs font-bold uppercase tracking-[0.1em] shadow hover:bg-blue-700 disabled:opacity-60"
                          >
                            {isTagSaving ? <i className="fa-solid fa-circle-notch fa-spin"></i> : 'Add'}
                          </button>
                        </div>
                      )}
                    </section>
                  </div>

                  {/* Timeline Column - Hidden on mobile when using dialer view as full screen right panel handles it */}
                  <div className="hidden lg:block flex-1 bg-slate-50/50 p-8 overflow-y-auto relative">
                    <div className="max-w-2xl mx-auto">
                      <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-[0.2em] mb-8">Lead Activity Timeline</h3>

                      <div className="space-y-8 relative">
                        {leadActivities.length > 0 ? (
                          <>
                            <div className="absolute left-5 top-2 bottom-2 w-0.5 bg-slate-200"></div>
                            {leadActivities
                              .filter((activity) => {
                                // CRITICAL: Double-check that activity belongs to current active lead
                                // This prevents showing activities from other leads during power dialing
                                const belongsToActiveLead = activity.lead_id === activeLead?.id;
                                if (!belongsToActiveLead) {
                                  console.warn('Filtering out activity that does not belong to active lead:', {
                                    activityId: activity.id,
                                    activityLeadId: activity.lead_id,
                                    activeLeadId: activeLead?.id
                                  });
                                }
                                return belongsToActiveLead;
                              })
                              .map((activity) => {
                                const timeAgo = formatTimeAgo(new Date(activity.created_at));
                                // Handle metadata - it might be a string (JSON) or already an object
                                let metadata: any = {};
                                try {
                                  if (typeof activity.metadata === 'string') {
                                    metadata = JSON.parse(activity.metadata);
                                  } else if (activity.metadata && typeof activity.metadata === 'object') {
                                    metadata = activity.metadata;
                                  }
                                } catch (e) {
                                  console.warn('Error parsing metadata:', e);
                                  metadata = {};
                                }

                                return (
                                  <div key={activity.id} className="relative pl-12">
                                    {/* Icon based on activity type */}
                                    <div className="absolute left-0 top-0 w-10 h-10 rounded-2xl bg-white border border-slate-200 shadow-sm flex items-center justify-center z-10">
                                      {activity.activity_type === 'call' ? (
                                        <i className="fa-solid fa-phone text-blue-600"></i>
                                      ) : activity.activity_type === 'disposition_change' ? (
                                        <i className="fa-solid fa-tag text-green-600"></i>
                                      ) : (
                                        <i className="fa-solid fa-circle text-slate-400"></i>
                                      )}
                                    </div>

                                    {/* Activity content */}
                                    <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                                      <div className="flex justify-between items-start mb-3">
                                        <div className="flex-1">
                                          <span className="text-sm font-bold text-slate-900">
                                            {activity.activity_type === 'call'
                                              ? metadata?.call_result === 'rejected'
                                                ? 'Call Rejected'
                                                : metadata?.call_result === 'failed'
                                                  ? 'Call Failed'
                                                  : 'Call Ended'
                                              : activity.activity_type === 'disposition_change'
                                                ? 'Status Changed'
                                                : activity.description}
                                          </span>
                                          {/* Show user name for status changes */}
                                          {activity.activity_type === 'disposition_change' && metadata?.user_name && (
                                            <div className="flex items-center gap-1.5 mt-1">
                                              <i className="fa-solid fa-user text-xs text-slate-400"></i>
                                              <span className="text-xs text-slate-500 font-medium">
                                                by {metadata.user_name}
                                              </span>
                                            </div>
                                          )}
                                        </div>
                                        <span className="text-[10px] font-medium text-slate-400">{timeAgo}</span>
                                      </div>

                                      {/* Description */}
                                      <p className="text-sm text-slate-600 mb-2">{activity.description}</p>

                                      {/* Call details */}
                                      {activity.activity_type === 'call' && (
                                        <CallRecordingDisplay 
                                          activity={activity}
                                          metadata={metadata}
                                          phoneNumber={metadata?.phone_number}
                                          callType={metadata?.call_type}
                                          duration={metadata?.duration_seconds}
                                        />
                                      )}

                                      {/* Status change details */}
                                      {activity.activity_type === 'disposition_change' && (
                                        <div className="bg-green-50 rounded-lg p-3 border border-green-100 mt-3">
                                          <div className="flex items-center gap-2 text-xs mb-2">
                                            <span className="text-slate-500">From:</span>
                                            <span className="px-2 py-0.5 rounded bg-white border border-green-200 text-green-700 font-semibold">
                                              {metadata?.old_status_display || metadata?.old_status || 'Unknown'}
                                            </span>
                                            <i className="fa-solid fa-arrow-right text-green-600 text-xs"></i>
                                            <span className="px-2 py-0.5 rounded bg-white border border-green-200 text-green-700 font-semibold">
                                              {metadata?.new_status_display || metadata?.new_status || 'Unknown'}
                                            </span>
                                          </div>
                                          {metadata?.bz_attempt_number != null && (
                                            <p className="text-[11px] text-amber-700 font-medium">
                                              BZ attempt #{metadata.bz_attempt_number}
                                            </p>
                                          )}
                                          {metadata?.auto_converted_from_bz && (
                                            <p className="text-[11px] text-amber-700 font-medium">
                                              Auto-converted to NW# after 3 BZ attempts
                                            </p>
                                          )}
                                          
                                          {/* Show Qualification Details if present */}
                                          {(metadata?.estimated_debt || metadata?.unfiled_years || metadata?.tax_type) && (
                                            <div className="mt-3 pt-3 border-t border-green-200/50">
                                              <p className="text-[10px] font-bold text-green-800 uppercase tracking-wider mb-2">Qualification Details</p>
                                              <div className="grid grid-cols-2 gap-2 text-xs">
                                                {metadata.estimated_debt && (
                                                  <div>
                                                    <span className="text-green-600 block text-[10px] uppercase">Tax Debt</span>
                                                    <span className="font-semibold text-green-900">${parseFloat(metadata.estimated_debt).toLocaleString()}</span>
                                                  </div>
                                                )}
                                                {metadata.unfiled_years && (
                                                  <div>
                                                    <span className="text-green-600 block text-[10px] uppercase">Tax Year(s)</span>
                                                    <span className="font-semibold text-green-900">{metadata.unfiled_years}</span>
                                                  </div>
                                                )}
                                                {metadata.tax_type && (
                                                  <div className="col-span-2">
                                                    <span className="text-green-600 block text-[10px] uppercase">Tax Type</span>
                                                    <span className="font-semibold text-green-900">{metadata.tax_type}</span>
                                                  </div>
                                                )}
                                              </div>
                                            </div>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                          </>
                        ) : (
                          <div className="text-center py-12">
                            <i className="fa-solid fa-inbox text-slate-300 text-4xl mb-3"></i>
                            <p className="text-sm text-slate-400">No activities yet</p>
                            <p className="text-xs text-slate-300 mt-1">Activities will appear here as you interact with this lead</p>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </main>

              {/* 3. RIGHT PANEL (THE ENGINE) - Mobile Full Screen */}
              <aside className={`
                w-full lg:w-[400px] bg-white border-l border-slate-100 flex flex-col min-h-0
                fixed inset-0 z-50 lg:static lg:z-auto
                transform transition-transform duration-300
                ${isSidebarOpen ? 'translate-x-full lg:translate-x-0' : 'translate-x-0'}
                lg:translate-x-0
              `}>
                {/* Mobile Header for Right Panel */}
                <div className="lg:hidden h-14 border-b border-slate-100 flex items-center justify-between px-4 bg-white shrink-0">
                   <h3 className="font-bold text-slate-900">Dialer</h3>
                   <button 
                     onClick={() => setActiveView('contacts')}
                     className="text-slate-500 hover:text-slate-900 p-2"
                   >
                     <i className="fa-solid fa-times text-lg"></i>
                   </button>
                </div>

                {/* Dialer UI */}
                <div className="bg-[#1E293B] shadow-inner h-[160px] lg:h-[160px] shrink-0 overflow-hidden relative flex flex-col">
                  {/* Video elements are now at root level for WebPhone initialization */}


                  {isDownloadingRecordings && (
                    <div className="absolute inset-0 bg-slate-900/90 z-20 flex flex-col items-center justify-center text-white p-6 text-center">
                      <i className="fa-solid fa-cloud-arrow-down text-3xl mb-4 text-blue-400 animate-bounce"></i>
                      <p className="text-sm font-bold mb-2">Downloading Recordings...</p>
                      <p className="text-xs text-slate-400 font-mono">{downloadProgress}</p>
                    </div>
                  )}

                  {/* WebPhone Dialer UI - compact */}
                  <div className="flex-1 flex flex-col items-center justify-center p-2 text-white min-h-0 gap-0.5">
                    <p className="text-[10px] text-slate-400 uppercase tracking-widest text-center leading-tight">{webPhoneStatus}</p>
                    {isPowerDialing && (
                      <p className="text-[10px] text-amber-400 font-bold uppercase tracking-widest leading-tight">⚡ Power Dialer Active</p>
                    )}
                    {powerDialerEnabled && webPhoneReady && !isPowerDialing && (
                      <p className="text-[10px] text-amber-400 font-bold uppercase tracking-widest leading-tight">⚡ Power Dialer Enabled</p>
                    )}

                    {activeLead?.phone && (
                      <div className="text-center w-full leading-tight">
                        <p className="text-[10px] text-slate-400">Current Lead · <span className="font-bold text-white">{activeLead.phone}</span> {activeLead.first_name} {activeLead.last_name}</p>
                      </div>
                    )}

                    {currentCall ? (
                      <div className="flex gap-2 mt-1">
                        <button
                          onClick={async () => {
                            if (!currentCall) return;

                            try {
                              setWebPhoneStatus('Ending call...');

                              // WebPhoneInviter extends SIP.js Inviter
                              const session = currentCall as any;

                              // Check session state - if it's still initializing, use cancel()
                              // Otherwise use bye() for established calls
                              const sessionState = session.state || (session as any).sessionState;

                              if (sessionState === 'Initial' || sessionState === 'Establishing') {
                                // Call hasn't been established yet, cancel it
                                if (session.cancel) {
                                  await session.cancel();
                                } else if (session.bye) {
                                  // Fallback to bye if cancel doesn't exist
                                  await session.bye();
                                }
                              } else {
                                // Call is established, use bye()
                                if (session.bye) {
                                  await session.bye();
                                } else if (session.terminate) {
                                  // Fallback to terminate
                                  await session.terminate();
                                }
                              }

                            } catch (error: any) {
                              console.error('Error ending call:', error);
                              // On error, still clear the state
                              setCurrentCall(null);
                              currentCallRef.current = null;
                              setCallStartTime(null);
                              setWebPhoneStatus('Call ended');
                            }
                          }}
                          className="mt-1 px-6 py-3 bg-red-600 hover:bg-red-700 rounded-xl text-sm font-bold flex items-center gap-2 transition-all shadow-lg"
                        >
                          <i className="fa-solid fa-phone-slash text-base"></i> End Call
                        </button>
                      </div>
                    ) : webPhoneReady && activeLead?.phone && !powerDialerEnabled ? (
                      <button
                        onClick={() => handleDial()}
                        disabled={!webPhoneReady || !activeLead?.phone}
                        className="mt-1 px-8 py-3 bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-sm font-bold flex items-center gap-2 transition-all shadow-lg"
                      >
                        <i className="fa-solid fa-phone text-base"></i> Call {activeLead.phone}
                      </button>
                    ) : rcNeedsConnect ? (
                      <div className="mt-1 text-center">
                        <p className="text-[10px] text-slate-400 mb-1">Sign in with your RingCentral account to make calls.</p>
                        <a
                          href="/api/auth/ringcentral"
                          className="inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition-all"
                        >
                          <i className="fa-solid fa-link"></i> Connect RingCentral
                        </a>
                      </div>
                    ) : !webPhoneReady ? (
                      <div className="mt-1 text-center">
                        <i className="fa-solid fa-circle-notch fa-spin text-blue-400 text-base"></i>
                        <p className="text-[10px] text-slate-400 mt-0.5">Initializing...</p>
                      </div>
                    ) : powerDialerEnabled && webPhoneReady ? (
                      <div className="mt-1 text-center">
                        <p className="text-[10px] text-amber-400 font-bold">Auto-dialing enabled</p>
                        <p className="text-[10px] text-slate-400">Will dial when lead is selected</p>
                      </div>
                    ) : (
                      <div className="mt-1 text-center">
                        <p className="text-[10px] text-slate-400">Select a lead to call</p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Dispositions - fills remaining height, scrolls internally */}
                <div className="flex-1 min-h-0 overflow-y-auto p-6 bg-slate-50/30 pb-24 lg:pb-6">
                  <>
                    <div className="mb-6">
                      <h4 className="text-sm font-bold text-slate-900 mb-1">Select Outcome <span className="text-red-500">*</span></h4>
                      <p className="text-[11px] text-slate-500">You must disposition this lead to move to the next item in queue.</p>
                      {bzAttemptCount > 0 && (
                        <p className="text-[11px] text-amber-600 font-medium mt-1.5 flex items-center gap-1">
                          <i className="fa-solid fa-phone-slash text-amber-500"></i>
                          BZ attempts: {bzAttemptCount} {bzAttemptCount >= 2 && <span className="text-amber-700">(3rd will auto-convert to NW#)</span>}
                        </p>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2 mb-6">
                      {DISPOSITION_OPTIONS.map((option) => {
                        const isActive = selectedDisposition === option;
                        const isQualified = option === 'Qualified';
                        return (
                          <button
                            key={option}
                            onClick={async () => {
                              if (isQualified) {
                                setSelectedDisposition('Qualified');
                                return;
                              }
                              setSelectedDisposition(option);
                              if (activeLead) {
                                await handleSubmitDisposition(option);
                              }
                            }}
                            className={`p-2.5 rounded-xl text-[11px] font-bold transition-all border ${isActive
                              ? 'bg-indigo-600 text-white border-indigo-700 shadow-md shadow-indigo-200'
                              : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-400 hover:text-indigo-600'
                              }`}
                          >
                            {option}
                          </button>
                        );
                      })}
                    </div>

                    {/* Qualification Details - always on display */}
                    <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
                      <div className="flex items-center gap-2 mb-4 border-b border-slate-50 pb-4">
                        <div className="w-7 h-7 bg-green-50 rounded-lg flex items-center justify-center text-green-600">
                          <i className="fa-solid fa-check-to-slot text-xs"></i>
                        </div>
                        <h5 className="font-bold text-sm">Qualification Details</h5>
                      </div>
                      <div className="space-y-4">
                        <div>
                          <label className="block text-[10px] font-bold text-slate-400 uppercase mb-2">Tax Debt</label>
                          <div className="relative">
                            <span className="absolute left-4 top-3.5 text-slate-400 text-sm font-bold">$</span>
                            <input
                              type="number"
                              value={qualificationTaxDebt}
                              onChange={(e) => setQualificationTaxDebt(e.target.value)}
                              placeholder="0.00"
                              className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 pl-8 text-sm outline-none focus:ring-2 focus:ring-blue-100 placeholder:text-slate-300 font-medium"
                            />
                          </div>
                        </div>
                        <div>
                          <label className="block text-[10px] font-bold text-slate-400 uppercase mb-2">Tax Year(s)</label>
                          <input
                            type="text"
                            value={qualificationTaxYear}
                            onChange={(e) => setQualificationTaxYear(e.target.value)}
                            placeholder="e.g. 2018, 2019, 2021"
                            className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 placeholder:text-slate-300 font-medium"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-bold text-slate-400 uppercase mb-2">Tax Type</label>
                          <div className="flex gap-2">
                            {['Federal', 'State', 'Both'].map((type) => (
                              <label key={type} className={`flex-1 cursor-pointer border rounded-xl p-2 text-center text-xs font-bold transition-all ${
                                qualificationTaxType === type
                                  ? 'bg-green-600 text-white border-green-600 shadow-sm'
                                  : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'
                              }`}>
                                <input
                                  type="radio"
                                  name="taxType"
                                  value={type}
                                  checked={qualificationTaxType === type}
                                  onChange={(e) => setQualificationTaxType(e.target.value)}
                                  className="hidden"
                                />
                                {type}
                              </label>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                </div>

                {/* Final Submission - Show only when "Qualified" is selected as disposition */}
                {activeLead && selectedDisposition === 'Qualified' && (
                  <div className="p-6 border-t border-slate-100 bg-white">
                    {hasBeenSubmittedToIRSLogics ? (
                      <div className="w-full bg-green-50 border border-green-200 text-green-800 py-3.5 rounded-xl font-bold text-sm flex items-center justify-center gap-3">
                        <i className="fa-solid fa-check-circle"></i>
                        Already Submitted to IRS Logics
                      </div>
                    ) : (
                      <button
                        onClick={handleSubmitToIRSLogics}
                        disabled={isSubmittingDisposition || !activeLead || hasBeenSubmittedToIRSLogics}
                        className="w-full bg-slate-900 text-white py-3.5 rounded-xl font-bold text-sm shadow-xl hover:bg-slate-800 transition-all flex items-center justify-center gap-3 group disabled:opacity-60 disabled:cursor-not-allowed btn-premium"
                      >
                        {isSubmittingDisposition ? (
                          <>
                            <i className="fa-solid fa-circle-notch fa-spin"></i>
                            Saving...
                          </>
                        ) : (
                          <>
                            Submit to IRSLogics
                            <i className="fa-solid fa-arrow-right text-[10px] group-hover:translate-x-1 transition-transform"></i>
                          </>
                        )}
                      </button>
                    )}
                    {/* <div className="flex justify-center mt-3">
                    <button
                      onClick={handleDownloadAllRecordings}
                      disabled={isDownloadingRecordings}
                      className="text-[10px] text-blue-500 hover:text-blue-700 underline flex items-center gap-1"
                    >
                      {isDownloadingRecordings ? <i className="fa-solid fa-circle-notch fa-spin"></i> : <i className="fa-solid fa-download"></i>}
                      Download All Recordings (90 Days)
                    </button>
                  </div>
                  <p className="text-center text-[10px] text-slate-400 mt-2 px-4 leading-relaxed">
                    Submitting will sync data, update pipeline stage, and auto-load next lead in queue.
                  </p> */}
                  </div>
                )}

                {/* Power Dialing Status */}
                {isPowerDialing && (
                  <div className="p-6 border-t border-slate-100 bg-amber-50">
                    <div className="text-center">
                      <div className="flex items-center justify-center gap-2 mb-2">
                        <i className="fa-solid fa-bolt text-amber-600 animate-pulse"></i>
                        <p className="text-sm font-bold text-amber-900">Power Dialing Active</p>
                      </div>
                      <p className="text-xs text-amber-700">
                        Select a disposition to automatically move to the next call
                      </p>
                      <p className="text-xs text-amber-600 mt-1 font-mono">
                        {powerDialingIndex + 1} / {powerDialingLeads.length}
                      </p>
                    </div>
                  </div>
                )}
              </aside>
            </>
          )
        }

        {/* VIEW: CONTACTS */}
        {
          activeView === 'contacts' && (
            <>
              {/* 2. MAIN CONTENT AREA */}
              <main className="flex-1 flex flex-col overflow-hidden">

                {/* Top Toolbar */}
                <header className="bg-white border-b border-slate-200 px-4 lg:px-8 h-20 flex items-center justify-between shrink-0">
                  <div className="flex items-center gap-4">
                    <button 
                      onClick={() => setIsSidebarOpen(true)}
                      className="lg:hidden text-slate-600 hover:text-slate-900"
                    >
                      <i className="fa-solid fa-bars text-lg"></i>
                    </button>
                    <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Contacts</h1>
                    {/* <div className="h-6 w-px bg-slate-200"></div>
                <div className="flex bg-slate-100 p-1 rounded-xl">
                  <button className="px-4 py-1.5 text-xs font-bold bg-white shadow-sm rounded-lg text-blue-600">Smart Lists</button>
                  <button className="px-4 py-1.5 text-xs font-bold text-slate-500 hover:text-slate-900 transition-colors">Segments</button>
                </div> */}
                  </div>

                  <div className="flex items-center gap-2 lg:gap-3">
                    {/* <div className="relative group">
                  <i className="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm"></i>
                  <input type="text" placeholder="Search by name, tag, or email..." className="pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 outline-none w-72 transition-all group-hover:bg-white" />
                </div> */}

                    <input
                      type="file"
                      accept=".csv"
                      className="hidden"
                      ref={fileInputRef}
                      onChange={handleFileSelect}
                    />
                    <button
                      onClick={() => setShowDeleteModal(true)}
                      className="bg-white border border-red-200 text-red-600 px-3 lg:px-5 py-2.5 rounded-xl font-bold text-sm shadow-sm hover:bg-red-50 transition-all flex items-center gap-2"
                    >
                      <i className="fa-solid fa-trash-can text-[10px]"></i>
                      <span className="hidden sm:inline">Delete Leads</span>
                    </button>
                    <button
                      onClick={() => setShowImportModal(true)}
                      disabled={isImporting}
                      className="bg-white border border-slate-200 text-slate-600 px-3 lg:px-5 py-2.5 rounded-xl font-bold text-sm shadow-sm hover:bg-slate-50 transition-all flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      <i className="fa-solid fa-cloud-arrow-up text-xs"></i>
                      <span className="hidden sm:inline">Import CSV</span>
                    </button>

                    <button
                      onClick={() => setShowLeadModal(true)}
                      className="bg-blue-600 text-white px-3 lg:px-5 py-2.5 rounded-xl font-bold text-sm shadow-lg shadow-blue-100 hover:bg-blue-700 transition-all flex items-center gap-2"
                    >
                      <i className="fa-solid fa-plus text-[10px]"></i> <span className="hidden sm:inline">Add New Lead</span>
                    </button>
                  </div>
                </header>

                {/* Sub-Header / Filters */}
                <div className="bg-white px-4 lg:px-8 py-3 border-b border-slate-100 flex items-center justify-between shadow-sm overflow-x-auto">
                  <div className="flex items-center gap-2">
                    {/* Smart List Tabs */}
                    {/* <button
                  className={`text-xs font-bold pb-3 px-3 border-b-2 ${
                    viewMode === 'all'
                      ? 'border-blue-600 text-slate-900'
                      : 'border-transparent text-slate-400 hover:text-slate-600'
                  }`}
                  onClick={() => {
                    setViewMode('all');
                    setCurrentPage(1);
                    setStatusFilter('All');
                  }}
                >
                  All Contacts
                </button> */}
                    {/* <button
                  className={`text-xs font-medium pb-3 px-3 transition-colors flex items-center gap-1.5 ${
                    viewMode === 'untouched'
                      ? 'text-blue-600 border-b-2 border-blue-600'
                      : 'text-slate-400 hover:text-slate-600 border-b-2 border-transparent'
                  }`}
                  onClick={() => {
                    setViewMode('untouched');
                    setCurrentPage(1);
                    setStatusFilter('All');
                    setDateFilterMode('all');
                    setSelectedDate('');
                    setSelectedMonth('');
                  }}
                >
                  Untouched Leads
                  {viewMode === 'untouched' && (
                    <span className="bg-blue-50 text-blue-600 text-[10px] px-1.5 py-0.5 rounded-md font-bold">
                      NEW
                    </span>
                  )}
                </button>
                <button className="text-xs font-medium text-slate-400 hover:text-slate-600 pb-3 px-3 transition-colors flex items-center gap-1.5">
                  Newly Added <span className="bg-slate-100 text-[10px] px-1.5 py-0.5 rounded-md">24</span>
                </button>
                <button className="text-xs font-medium text-slate-400 hover:text-slate-600 pb-3 px-3 transition-colors flex items-center gap-1.5">
                  Follow-ups Due <span className="bg-red-50 text-red-600 text-[10px] px-1.5 py-0.5 rounded-md font-bold">5</span>
                </button>
                <button className="text-xs font-medium text-slate-400 hover:text-slate-600 pb-3 px-3 transition-colors flex items-center gap-1.5">
                  Qualified Deals
                </button> */}
                  </div>

                  <div className="flex items-center gap-4 mb-2">
                    {/* <button className="text-[11px] font-bold text-slate-500 uppercase flex items-center gap-1 hover:text-blue-600">
                  <i className="fa-solid fa-sliders text-xs"></i> Filter
                </button>
                <button className="text-[11px] font-bold text-slate-500 uppercase flex items-center gap-1 hover:text-blue-600">
                  <i className="fa-solid fa-columns text-xs"></i> Columns
                </button> */}
                  </div>
                </div>

                {viewMode === 'all' && (
                  <div className="bg-white px-8 py-4 border-b border-slate-100 space-y-4">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="text-[10px] font-bold uppercase text-slate-400 tracking-[0.2em]">
                        Status
                      </span>
                      
                      {/* Mobile Status Dropdown (Visible only on mobile) */}
                      <div className="lg:hidden relative">
                        <select
                          value={statusFilter}
                          onChange={(e) => {
                            setStatusFilter(e.target.value);
                            setCurrentPage(1);
                          }}
                          className="appearance-none px-4 py-2 pr-8 rounded-xl border border-slate-200 text-xs font-bold text-slate-600 bg-white focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300 transition-all shadow-sm"
                        >
                          {STATUS_FILTERS.map((statusOption) => (
                            <option key={statusOption} value={statusOption}>
                              {statusOption}
                            </option>
                          ))}
                        </select>
                        <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400">
                          <i className="fa-solid fa-chevron-down text-[10px]"></i>
                        </div>
                      </div>

                      {/* Desktop Status Buttons (Hidden on mobile) */}
                      <div className="hidden lg:flex flex-wrap gap-2">
                        {STATUS_FILTERS.map((statusOption) => {
                          const isActive = statusFilter === statusOption;
                          return (
                            <button
                              key={statusOption}
                              onClick={() => {
                                setStatusFilter(statusOption);
                                setCurrentPage(1);
                              }}
                              className={`px-3 py-1 rounded-xl text-xs font-bold border transition-all ${isActive
                                ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                                : 'bg-white text-slate-500 border-slate-200 hover:border-blue-200 hover:text-blue-600'
                                }`}
                            >
                              {statusOption}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="relative">
                      <button
                        onClick={() => setShowDatePicker((prev) => !prev)}
                        className="px-4 py-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-600 flex items-center gap-2 hover:border-blue-200 hover:text-blue-600 transition-all"
                      >
                        <i className="fa-regular fa-calendar"></i>
                        {getDateFilterLabel()}
                        <i
                          className={`fa-solid fa-chevron-${showDatePicker ? 'up' : 'down'} text-[10px]`}
                        ></i>
                      </button>

                      {showDatePicker && (
                        <div className="absolute z-50 mt-2 w-[320px] max-w-sm bg-white border border-slate-200 rounded-2xl shadow-2xl p-4 space-y-4">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-bold uppercase text-slate-400 tracking-[0.2em]">
                              Quick Picks
                            </span>
                            <button
                              onClick={() => setShowDatePicker(false)}
                              className="text-[10px] text-slate-400 hover:text-slate-700"
                            >
                              Close
                            </button>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {[
                              { label: 'Today', mode: 'today' as DateFilterMode },
                              { label: 'Last 3 Days', mode: 'last3' as DateFilterMode },
                              { label: 'This Week', mode: 'week' as DateFilterMode },
                              { label: 'This Month', mode: 'month' as DateFilterMode },
                            ].map((item) => (
                              <button
                                key={item.mode}
                                onClick={() => applyQuickDateFilter(item.mode)}
                                className={`px-3 py-1 rounded-xl text-xs font-bold border transition-all ${dateFilterMode === item.mode
                                  ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                                  : 'bg-white text-slate-500 border-slate-200 hover:border-blue-200 hover:text-blue-600'
                                  }`}
                              >
                                {item.label}
                              </button>
                            ))}
                          </div>

                          <div className="space-y-3">
                            <label className="flex flex-col gap-2 text-[11px] font-semibold text-slate-500">
                              <span>Select Date</span>
                              <input
                                type="date"
                                value={selectedDate}
                                onChange={(e) => {
                                  const value = e.target.value;
                                  setSelectedDate(value);
                                  setDateFilterMode(value ? 'date' : 'all');
                                  setCurrentPage(1);
                                  if (value) setShowDatePicker(false);
                                }}
                                className="px-3 py-1 rounded-xl border border-slate-200 text-xs focus:ring-2 focus:ring-blue-100 outline-none"
                              />
                            </label>
                            <label className="flex flex-col gap-2 text-[11px] font-semibold text-slate-500">
                              <span>Select Month</span>
                              <input
                                type="month"
                                value={selectedMonth}
                                onChange={(e) => {
                                  const value = e.target.value;
                                  setSelectedMonth(value);
                                  setDateFilterMode(value ? 'customMonth' : 'all');
                                  setCurrentPage(1);
                                  if (value) setShowDatePicker(false);
                                }}
                                className="px-3 py-1 rounded-xl border border-slate-200 text-xs focus:ring-2 focus:ring-blue-100 outline-none"
                              />
                            </label>
                            <button
                              onClick={() => applyQuickDateFilter('all')}
                              className="w-full px-3 py-2 rounded-xl text-xs font-bold border border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700"
                            >
                              Clear Filters
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* CONTACTS TABLE AREA */}
                <div className="flex-1 overflow-auto bg-white p-4 lg:p-8">
                  {/* Mobile List View (Visible only on mobile) */}
                  <div className="lg:hidden space-y-4">
                    {loading ? (
                      <div className="text-center py-12 text-slate-500">
                        <i className="fa-solid fa-circle-notch fa-spin text-blue-600 mr-2"></i> Loading leads...
                      </div>
                    ) : leads.length === 0 ? (
                      <div className="text-center py-12 text-slate-500">
                        No leads found. Add a new lead to get started.
                      </div>
                    ) : (
                      leads.map((lead) => (
                        <div 
                          key={lead.id}
                          className="bg-white border border-slate-100 rounded-2xl p-4 shadow-sm active:scale-[0.99] transition-transform"
                          onClick={() => handleLeadClick(lead)}
                        >
                          <div className="flex justify-between items-start mb-2">
                            <div>
                              <h3 className="font-bold text-slate-900 text-base mb-0.5">
                                {lead.first_name} {lead.last_name}
                              </h3>
                              <p className="text-slate-500 font-mono text-sm">{lead.phone || 'No phone'}</p>
                            </div>
                            <input
                              type="checkbox"
                              className="rounded text-indigo-600 border-slate-300 checkbox-custom h-5 w-5"
                              checked={selectedLeads.has(lead.id)}
                              onChange={(e) => {
                                e.stopPropagation();
                                toggleLeadSelection(lead.id);
                              }}
                              onClick={(e) => e.stopPropagation()}
                            />
                          </div>
                          
                          <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-50">
                            <span className="px-2.5 py-1 bg-amber-50 text-amber-700 border border-amber-200/50 rounded-lg text-xs font-bold uppercase tracking-wide">
                              {formatStatusForDisplay(lead.status)}
                            </span>
                            <span className="text-xs text-slate-400 font-medium">
                              {new Date(lead.created_at).toLocaleDateString()}
                            </span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  {/* Desktop Table View (Hidden on mobile) */}
                  <table className="hidden lg:table w-full text-left border-collapse min-w-[1000px]">
                    <thead>
                      <tr className="border-b border-slate-100 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-left">
                        <th className="py-3 px-2 w-10">
                          <input
                            type="checkbox"
                            className="rounded text-indigo-600 border-slate-300 checkbox-custom"
                            checked={leads.length > 0 && selectedLeads.size === leads.length}
                            onChange={(e) => {
                              if (e.target.checked) {
                                const allIds = new Set(leads.map(l => l.id));
                                setSelectedLeads(allIds);
                              } else {
                                setSelectedLeads(new Set());
                              }
                            }}
                          />
                        </th>
                        <th className="py-3 px-4 hover:text-indigo-600 cursor-pointer group">
                          Lead Name {getSortIcon('name')}
                        </th>
                        <th className="py-3 px-4 hover:text-indigo-600 cursor-pointer group">
                          Address
                        </th>
                        <th className="py-3 px-4 hover:text-indigo-600 cursor-pointer group">
                          Contact Info {getSortIcon('contact')}
                        </th>
                        <th
                          className="py-3 px-4 hover:text-indigo-600 cursor-pointer group"
                          onClick={() => handleSort('status')}
                        >
                          Stage {getSortIcon('status')}
                        </th>
                        <th
                          className="py-3 px-4 hover:text-indigo-600 cursor-pointer group"
                          onClick={() => handleSort('created_at')}
                        >
                          Activity {getSortIcon('created_at')}
                        </th>
                        <th className="py-3 px-4">Tags</th>
                        <th className="py-3 px-4 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="text-sm">
                      {loading ? (
                        <tr>
                          <td colSpan={8} className="py-12 text-center text-slate-500">
                            <i className="fa-solid fa-circle-notch fa-spin text-blue-600 mr-2"></i> Loading leads...
                          </td>
                        </tr>
                      ) : leads.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="py-12 text-center text-slate-500">
                            No leads found. Add a new lead to get started.
                          </td>
                        </tr>
                      ) : (
                        leads.map((lead) => (
                          <tr
                            key={lead.id}
                            className="group hover:bg-white hover:shadow-sm transition-all border-b border-slate-50 cursor-pointer"
                            onClick={() => handleLeadClick(lead)}
                          >
                            <td className="py-3 px-2" onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                className="rounded text-indigo-600 border-slate-300 checkbox-custom"
                                checked={selectedLeads.has(lead.id)}
                                onChange={() => toggleLeadSelection(lead.id)}
                              />
                            </td>
                            <td className="py-3 px-4">
                              <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-600 font-bold flex items-center justify-center text-[11px]">
                                  {getInitials(lead.first_name, lead.last_name)}
                                </div>
                                <div>
                                  <div className="font-bold text-slate-900 group-hover:text-indigo-600 transition-colors">
                                    {lead.first_name} {lead.last_name}
                                  </div>
                                  <div className="text-[10px] text-slate-500 font-medium">
                                    {lead.lead_age ? `Age: ${lead.lead_age}` : ''}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td className="py-4 px-4">
                              <div className="text-slate-900 font-medium text-xs">
                                {lead.address_line1}
                              </div>
                              <div className="text-[11px] text-slate-500">
                                {lead.city && lead.state ? `${lead.city}, ${lead.state} ${lead.postal_code || ''}` : ''}
                              </div>
                            </td>
                            <td className="py-4 px-4">
                              <div className="text-slate-700 font-medium">{lead.phone || 'No phone'}</div>
                              <div className="text-[11px] text-slate-400 tracking-tight">{lead.email || 'No email'}</div>
                            </td>
                            <td className="py-4 px-4">
                              <span className="px-2.5 py-1 bg-amber-50 text-amber-700 border border-amber-200/50 rounded-lg text-[10px] font-bold">
                                {formatStatusForDisplay(lead.status)}
                              </span>
                            </td>
                            <td className="py-4 px-4">
                              <div className="text-slate-900 font-medium">{getTimeAgo(lead.created_at)}</div>
                              <div className="text-[10px] text-slate-400 font-semibold uppercase flex items-center gap-1">
                                <i className="fa-solid fa-phone text-blue-400 text-[9px]"></i> Created
                              </div>
                            </td>
                            <td className="py-4 px-4">
                              <div className="flex gap-1 flex-wrap w-24">
                                {lead.tags && lead.tags.length > 0 ? (
                                  lead.tags.map((tag, i) => (
                                    <span key={i} className="text-[9px] font-bold px-2 py-0.5 bg-blue-50 text-blue-600 rounded-md truncate max-w-full">
                                      {tag}
                                    </span>
                                  ))
                                ) : (
                                  <span className="text-[9px] text-slate-400 italic">No tags</span>
                                )}
                              </div>
                            </td>
                            <td className="py-4 px-4 text-right">
                              <button
                                onClick={(e) => handleLeadPhoneClick(e, lead)}
                                className="text-slate-400 hover:text-blue-600 p-2 transition-all"
                                title="Call Lead"
                              >
                                <i className="fa-solid fa-phone"></i>
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Power Dialer Section */}
                <div className="px-8 py-4 border-t border-slate-200 bg-gradient-to-r from-amber-50 to-orange-50 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${isPowerDialing
                      ? 'bg-amber-600 text-white animate-pulse'
                      : 'bg-amber-100 text-amber-600'
                      }`}>
                      <i className={`fa-solid ${isPowerDialing ? 'fa-phone' : 'fa-bolt'}`}></i>
                    </div>
                    <div>
                      <h4 className="text-sm font-bold text-slate-900">Power Dialer</h4>
                      <p className="text-xs text-slate-500">
                        {isPowerDialing
                          ? `Dialing ${powerDialingIndex + 1} of ${powerDialingLeads.length} leads...`
                          : selectedLeads.size > 0
                            ? `Dial ${selectedLeads.size} selected lead${selectedLeads.size === 1 ? '' : 's'}`
                            : `Dial filtered leads (${eligiblePowerDialCount} available)`
                        }
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {powerDialingLeads.length > 0 && !isPowerDialing && powerDialingIndex < powerDialingLeads.length && (
                      <button
                        onClick={() => startPowerDialing(undefined, true)}
                        disabled={!webPhoneReady || loading}
                        className="px-6 py-3 rounded-xl text-sm font-bold flex items-center gap-2 transition-all shadow-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
                        title={`Resume from lead ${powerDialingIndex + 1} of ${powerDialingLeads.length}`}
                      >
                        <i className="fa-solid fa-play"></i> Resume Power Dialer ({powerDialingLeads.length - powerDialingIndex} left)
                      </button>
                    )}
                    <button
                      onClick={() => startPowerDialing()}
                      disabled={!webPhoneReady || loading}
                      className={`px-6 py-3 rounded-xl text-sm font-bold flex items-center gap-2 transition-all shadow-lg ${isPowerDialing
                        ? 'bg-red-600 hover:bg-red-700 text-white'
                        : 'bg-amber-600 hover:bg-amber-700 text-white'
                        } disabled:opacity-50 disabled:cursor-not-allowed`}
                    >
                      {isPowerDialing ? (
                        <>
                          <i className="fa-solid fa-stop"></i> Stop Power Dialing
                        </>
                      ) : (
                        <>
                          <i className="fa-solid fa-bolt"></i> Start Power Dialing
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {/* Pagination / Status Footer */}
                <footer className="h-14 px-4 lg:px-8 border-t border-slate-200 bg-white flex items-center justify-between shrink-0">
                  <div className="flex items-center gap-4 flex-1 min-w-0">
                    <div className="text-xs font-semibold text-slate-500 truncate">
                      <span className="hidden sm:inline">Showing </span>
                      <span className="text-slate-900">{totalLeads > 0 ? (currentPage - 1) * itemsPerPage + 1 : 0} - {Math.min(currentPage * itemsPerPage, totalLeads)}</span>
                      <span className="hidden sm:inline"> of {totalLeads} Leads</span>
                      <span className="sm:hidden"> / {totalLeads}</span>
                    </div>
                    <div className="hidden sm:block h-4 w-px bg-slate-200"></div>
                    <div className="hidden sm:flex items-center gap-2">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Show:</span>
                      <select
                        value={itemsPerPage}
                        onChange={(e) => {
                          setItemsPerPage(Number(e.target.value));
                          setCurrentPage(1);
                          setPageCursors({});
                        }}
                        className="text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                      >
                        <option value={50}>50</option>
                        <option value={100}>100</option>
                        <option value={1000}>1k</option>
                      </select>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0 ml-2">
                    <button
                      onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                      className="h-8 w-8 rounded-lg hover:bg-slate-100 transition-all text-slate-400 flex items-center justify-center border border-slate-100 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <i className="fa-solid fa-chevron-left text-[10px]"></i>
                    </button>

                    <div className="hidden sm:flex items-center gap-1">
                      {getPageNumbers().map((pageNum) => (
                        <button
                          key={pageNum}
                          onClick={() => setCurrentPage(pageNum)}
                          className={`h-8 w-8 rounded-lg transition-all text-[11px] font-bold ${currentPage === pageNum
                            ? 'bg-blue-600 text-white shadow-lg shadow-blue-100'
                            : 'hover:bg-slate-100 text-slate-600'
                            }`}
                        >
                          {pageNum}
                        </button>
                      ))}
                    </div>
                    
                    {/* Mobile Page Indicator */}
                    <span className="sm:hidden text-xs font-bold text-slate-600 px-2">
                      {currentPage}
                    </span>

                    <button
                      onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                      disabled={currentPage === totalPages || totalPages === 0}
                      className="h-8 w-8 rounded-lg hover:bg-slate-100 transition-all text-slate-400 flex items-center justify-center border border-slate-100 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <i className="fa-solid fa-chevron-right text-[10px]"></i>
                    </button>
                  </div>
                </footer>
              </main>

              {/* Selection Bar (Fixed bottom - usually hidden until rows are checked) */}
              {selectedLeads.size > 0 && (
                <div className="fixed bottom-10 left-1/2 -translate-x-1/2 bg-slate-950 text-white px-8 py-4 rounded-3xl shadow-2xl flex items-center gap-10 ring-2 ring-blue-500/50 scale-100 transition-transform cursor-pointer border border-white/20">
                  <div className="flex items-center gap-2 border-r border-white/20 pr-10">
                    <span className="text-sm font-bold bg-blue-600 px-2 py-0.5 rounded text-white shadow-lg">{selectedLeads.size}</span>
                    <span className="text-xs font-medium tracking-wide">Leads Selected</span>
                  </div>
                  <div className="flex items-center gap-6">
                    <button
                      onClick={async () => {
                        setLoading(true);
                        try {
                          const selectedIds = Array.from(selectedLeads);
                          console.log('Selected lead IDs:', selectedIds);

                          const { data, error } = await supabase
                            .from('leads')
                            .select('*')
                            .in('id', selectedIds);

                          if (error) throw error;

                          console.log('Fetched leads from database:', data?.length, 'leads');
                          console.log('Fetched leads data:', data);

                          if (data && data.length > 0) {
                            // Ensure we have all selected leads - no deduplication
                            // If some leads weren't returned, log a warning
                            if (data.length !== selectedIds.length) {
                              console.warn(`Expected ${selectedIds.length} leads but got ${data.length}. Missing IDs:`,
                                selectedIds.filter(id => !data.find(l => l.id === id))
                              );
                            }
                            startPowerDialing(data);
                          } else {
                            toast.warning('No leads found for selected IDs');
                          }
                        } catch (err) {
                          console.error('Error starting power dial for selected:', err);
                          toast.error('Failed to start power dial');
                        } finally {
                          setLoading(false);
                        }
                      }}
                      className="text-xs font-bold hover:text-amber-400 transition-colors flex items-center gap-2"
                    >
                      <i className="fa-solid fa-bolt text-[11px]"></i> Power Dial
                    </button>
                    <button
                      onClick={async () => {
                        const leadCount = selectedLeads.size;
                        showConfirmation(
                          `Are you sure you want to delete ${leadCount} lead${leadCount === 1 ? '' : 's'}?`,
                          async () => {
                            setLoading(true);
                            try {
                              const { data: { session } } = await supabase.auth.getSession();
                              if (!session) {
                                toast.error('You must be logged in to delete leads');
                                setLoading(false);
                                return;
                              }

                              const response = await fetch('/api/leads/delete', {
                                method: 'POST',
                                headers: {
                                  'Content-Type': 'application/json',
                                  'Authorization': `Bearer ${session.access_token}`,
                                },
                                body: JSON.stringify({ leadIds: Array.from(selectedLeads) }),
                              });

                              const data = await response.json();

                              if (!response.ok) {
                                throw new Error(data.error || 'Failed to delete leads');
                              }

                              setSelectedLeads(new Set());
                              await fetchLeads();
                              toast.success(`Successfully deleted ${leadCount} lead${leadCount === 1 ? '' : 's'}`);
                            } catch (err: unknown) {
                              console.error('Error deleting leads:', err);
                              toast.error(err instanceof Error ? err.message : 'Failed to delete leads');
                            } finally {
                              setLoading(false);
                            }
                          }
                        );
                      }}
                      className="text-xs font-bold hover:text-red-400 transition-colors flex items-center gap-2"
                    >
                      <i className="fa-solid fa-trash-can text-[11px]"></i> Delete
                    </button>
                  </div>
                  <button
                    onClick={() => setSelectedLeads(new Set())}
                    className="text-[10px] bg-white/10 p-1.5 rounded hover:bg-white/20"
                    title="Close Selection bar"
                  >✕</button>
                </div>
              )}
            </>
          )
        }

        {/* VIEW: SETTINGS */}
        {activeView === 'settings' && (
          <main className="flex-1 p-8 lg:p-12 overflow-y-auto bg-[#F8FAFC]" key="settings-view">
            <header className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-6 mb-12">
              <div className="flex items-center gap-4">
                <button 
                  onClick={() => setIsSidebarOpen(true)}
                  className="lg:hidden text-slate-600 hover:text-slate-900"
                >
                  <i className="fa-solid fa-bars text-lg"></i>
                </button>
                <h1 className="text-4xl font-black tracking-tight text-slate-900 leading-none">
                  Settings <span className="text-indigo-600 italic">Management</span>
                </h1>
              </div>
            </header>

            <div className="max-w-7xl mx-auto space-y-8">
              {/* RingCentral Connect / Disconnect */}
              <div className="dashboard-card p-8">
                <h3 className="text-xl font-black text-slate-900 mb-2">RingCentral</h3>
                <p className="text-sm text-slate-500 mb-6">Connect your RingCentral account to make and receive calls from the dashboard.</p>
                <div className="flex flex-wrap items-center gap-4">
                  {rcLinkedInSettings === null ? (
                    <span className="text-sm text-slate-400 flex items-center gap-2">
                      <i className="fa-solid fa-circle-notch fa-spin"></i>
                      Checking...
                    </span>
                  ) : rcLinkedInSettings ? (
                    <>
                      <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-50 text-emerald-700 text-sm font-bold">
                        <i className="fa-solid fa-circle-check"></i>
                        Connected
                      </span>
                      <a
                        href="/api/auth/ringcentral"
                        className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-bold transition-all inline-flex items-center gap-2"
                      >
                        <i className="fa-solid fa-arrow-rotate-right"></i>
                        Reconnect
                      </a>
                      <button
                        type="button"
                        onClick={async () => {
                          setRcDisconnecting(true);
                          try {
                            const { data: { session } } = await supabase.auth.getSession();
                            if (!session) {
                              toast.error('Not authenticated');
                              return;
                            }
                            const res = await fetch('/api/auth/ringcentral/disconnect', {
                              method: 'POST',
                              headers: { Authorization: `Bearer ${session.access_token}` },
                            });
                            const data = await res.json();
                            if (!res.ok) throw new Error(data.error || 'Failed to disconnect');
                            setRcLinkedInSettings(false);
                            setRcNeedsConnect(true);
                            setWebPhoneStatus('Connect RingCentral to make calls');
                            toast.success('RingCentral disconnected');
                          } catch (e: any) {
                            toast.error(e.message || 'Failed to disconnect');
                          } finally {
                            setRcDisconnecting(false);
                          }
                        }}
                        disabled={rcDisconnecting}
                        className="px-4 py-2 rounded-xl bg-red-50 hover:bg-red-100 text-red-600 text-sm font-bold transition-all inline-flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        {rcDisconnecting ? (
                          <>
                            <i className="fa-solid fa-circle-notch fa-spin"></i>
                            Disconnecting...
                          </>
                        ) : (
                          <>
                            <i className="fa-solid fa-link-slash"></i>
                            Disconnect
                          </>
                        )}
                      </button>
                    </>
                  ) : (
                    <a
                      href="/api/auth/ringcentral"
                      className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold transition-all inline-flex items-center gap-2"
                    >
                      <i className="fa-solid fa-link"></i>
                      Connect RingCentral
                    </a>
                  )}
                </div>
              </div>

              {/* Create New User Section - Admin Only */}
              {userIsAdmin && (
                <div className="dashboard-card p-8">
                  <h3 className="text-xl font-black text-slate-900 mb-6">Create New User</h3>
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (!newUser.email || !newUser.password) {
                        toast.warning('Please fill in email and password');
                        return;
                      }

                      setIsCreatingUser(true);
                      try {
                        // Get auth token
                        const { data: { session } } = await supabase.auth.getSession();
                        if (!session) {
                          throw new Error('Not authenticated');
                        }

                        const response = await fetch('/api/users/create', {
                          method: 'POST',
                          headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${session.access_token}`,
                          },
                          body: JSON.stringify(newUser),
                        });

                        const data = await response.json();

                        if (!response.ok) {
                          throw new Error(data.error || 'Failed to create user');
                        }

                        toast.success('User created successfully!');
                        setNewUser({ email: '', password: '', name: '', role: 'user' });
                        // Refresh users list
                        await fetchUsers();
                      } catch (error: any) {
                        console.error('Error creating user:', error);
                        toast.error(error.message || 'Failed to create user');
                      } finally {
                        setIsCreatingUser(false);
                      }
                    }}
                    className="space-y-6"
                  >
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                      <div>
                        <label className="block text-xs font-bold text-slate-400 uppercase mb-2">Name</label>
                        <input
                          type="text"
                          value={newUser.name}
                          onChange={(e) => setNewUser({ ...newUser, name: e.target.value })}
                          placeholder="John Doe"
                          className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-slate-400 uppercase mb-2">Email *</label>
                        <input
                          type="email"
                          value={newUser.email}
                          onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                          placeholder="user@example.com"
                          required
                          className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-slate-400 uppercase mb-2">Password *</label>
                        <input
                          type="password"
                          value={newUser.password}
                          onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                          placeholder="••••••••"
                          required
                          minLength={6}
                          className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-slate-400 uppercase mb-2">Role *</label>
                        <select
                          value={newUser.role}
                          onChange={(e) => setNewUser({ ...newUser, role: e.target.value as 'admin' | 'user' })}
                          className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                          required
                        >
                          <option value="user">User</option>
                          <option value="admin">Admin</option>
                        </select>
                      </div>
                    </div>
                  <div className="flex justify-end">
                    <button
                      type="submit"
                      disabled={isCreatingUser}
                      className="px-6 py-3 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 transition-all disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2"
                    >
                      {isCreatingUser ? (
                        <>
                          <i className="fa-solid fa-circle-notch fa-spin"></i>
                          Creating...
                        </>
                      ) : (
                        <>
                          <i className="fa-solid fa-user-plus"></i>
                          Create User
                        </>
                      )}
                    </button>
                  </div>
                </form>
              </div>
              )}

              {/* Users List Section */}
              <div className="dashboard-card p-8">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-xl font-black text-slate-900">Organization Users</h3>
                  <button
                    onClick={fetchUsers}
                    disabled={isLoadingUsers}
                    className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold transition-all disabled:opacity-60 flex items-center gap-2"
                  >
                    <i className={`fa-solid fa-arrow-rotate-right ${isLoadingUsers ? 'fa-spin' : ''}`}></i>
                    Refresh
                  </button>
                </div>

                {isLoadingUsers ? (
                  <div className="text-center py-12">
                    <i className="fa-solid fa-circle-notch fa-spin text-2xl text-slate-400"></i>
                    <p className="text-sm text-slate-400 mt-3">Loading users...</p>
                  </div>
                ) : organizationUsers.length === 0 ? (
                  <div className="text-center py-12 bg-slate-50 rounded-2xl border border-slate-200">
                    <i className="fa-solid fa-users text-4xl text-slate-300 mb-3"></i>
                    <p className="text-sm text-slate-400 mb-2">No users found</p>
                    <p className="text-xs text-slate-300">Click Refresh to reload users</p>
                  </div>
                ) : (
                  <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
                    <table className="w-full">
                      <thead className="bg-slate-50 border-b border-slate-200">
                        <tr>
                          <th className="px-6 py-4 text-left text-xs font-black text-slate-400 uppercase tracking-widest">Name</th>
                          <th className="px-6 py-4 text-left text-xs font-black text-slate-400 uppercase tracking-widest">Email</th>
                          <th className="px-6 py-4 text-left text-xs font-black text-slate-400 uppercase tracking-widest">Role</th>
                          <th className="px-6 py-4 text-left text-xs font-black text-slate-400 uppercase tracking-widest">Created</th>
                          <th className="px-6 py-4 text-left text-xs font-black text-slate-400 uppercase tracking-widest">Last Sign In</th>
                          {userIsAdmin && (
                            <th className="px-6 py-4 text-left text-xs font-black text-slate-400 uppercase tracking-widest">Actions</th>
                          )}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {organizationUsers.map((user) => (
                          <tr key={user.id} className="hover:bg-slate-50 transition-colors">
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold text-sm">
                                  {user.name ? user.name.charAt(0).toUpperCase() : user.email.charAt(0).toUpperCase()}
                                </div>
                                <span className="text-sm font-semibold text-slate-900">{user.name || 'No name'}</span>
                              </div>
                            </td>
                            <td className="px-6 py-4 text-sm text-slate-600">{user.email}</td>
                            <td className="px-6 py-4">
                              <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold ${
                                user.role === 'admin' 
                                  ? 'bg-indigo-100 text-indigo-700' 
                                  : 'bg-slate-100 text-slate-600'
                              }`}>
                                {user.role === 'admin' ? 'Admin' : 'User'}
                              </span>
                            </td>
                            <td className="px-6 py-4 text-xs text-slate-400">
                              {new Date(user.created_at).toLocaleDateString()}
                            </td>
                            <td className="px-6 py-4 text-xs text-slate-400">
                              {user.last_sign_in_at ? new Date(user.last_sign_in_at).toLocaleDateString() : 'Never'}
                            </td>
                            {userIsAdmin && (
                              <td className="px-6 py-4">
                                <button
                                  onClick={() => deleteUser(user.id)}
                                  disabled={deletingUserId === user.id}
                                  className="px-3 py-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 text-xs font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                                >
                                  {deletingUserId === user.id ? (
                                    <>
                                      <i className="fa-solid fa-circle-notch fa-spin"></i>
                                      Deleting...
                                    </>
                                  ) : (
                                    <>
                                      <i className="fa-solid fa-trash"></i>
                                      Delete
                                    </>
                                  )}
                                </button>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </main>
        )}
      </div>

      {showImportModal && (
        <div className="modal-overlay">
          <div className="glass-modal animate-float">
            <button
              onClick={resetImportModal}
              className="absolute top-6 right-6 text-slate-400 hover:text-slate-700 transition-colors"
            >
              <i className="fa-solid fa-xmark text-xl"></i>
            </button>

            <h3 className="text-2xl font-black text-slate-900 mb-2 tracking-tight">Import Leads</h3>
            <p className="text-xs font-medium text-slate-500 mb-6 uppercase tracking-widest">
              Upload a CSV file and optionally apply tags to every imported lead.
            </p>

            {importError && (
              <div className="mb-4 px-4 py-3 rounded-2xl bg-red-50 border border-red-100 text-[12px] font-semibold text-red-600 flex items-center gap-2">
                <i className="fa-solid fa-circle-exclamation"></i>
                {importError}
              </div>
            )}

            <form onSubmit={handleImportSubmit} className="space-y-6">
              <div>
                <label className="glass-label">CSV File</label>
                <div className="flex flex-col gap-3 md:flex-row md:items-center">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="px-4 py-2 rounded-xl border border-slate-200 text-xs font-bold uppercase tracking-[0.15em] text-slate-600 hover:bg-slate-50 transition-all"
                  >
                    Choose File
                  </button>
                  <span className="text-sm font-semibold text-slate-500 truncate">
                    {pendingImportFile ? pendingImportFile.name : 'No file selected'}
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 mt-2">Accepted format: CSV with headers</p>
              </div>

              <div>
                <label className="glass-label">Lead Source</label>
                <input
                  type="text"
                  value={importSource}
                  onChange={(e) => setImportSource(e.target.value)}
                  placeholder="CSV Import"
                  className="glass-input w-full rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 placeholder:text-slate-400"
                />
                <p className="text-[11px] text-slate-400 mt-2">
                  The origin of these leads (e.g., "Facebook Ads", "Affiliate"). Defaults to "CSV Import".
                </p>
              </div>

              <div>
                <label className="glass-label">Tags (comma separated)</label>
                <input
                  type="text"
                  value={importTags}
                  onChange={(e) => setImportTags(e.target.value)}
                  placeholder="Imported, 2024 Campaign"
                  className="glass-input w-full rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 placeholder:text-slate-400"
                />
                <p className="text-[11px] text-slate-400 mt-2">
                  These tags will be attached to every lead in the CSV. Leave blank to use the default “Imported” tag.
                </p>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={resetImportModal}
                  className="px-5 py-3 rounded-xl border border-slate-200/60 bg-white/50 text-xs font-bold uppercase tracking-[0.15em] text-slate-500 hover:bg-white hover:text-slate-900 hover:border-slate-300 transition-all shadow-sm"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isImporting}
                  className="px-8 py-3 rounded-xl bg-blue-600 text-white text-xs font-black uppercase tracking-[0.2em] shadow-lg shadow-blue-500/20 hover:bg-blue-700 disabled:opacity-70 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {isImporting ? (
                    <>
                      <i className="fa-solid fa-circle-notch fa-spin"></i>
                      Importing...
                    </>
                  ) : (
                    <>
                      <i className="fa-solid fa-cloud-arrow-up text-xs"></i>
                      Import CSV
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Duplicate Leads Modal */}
      {showDuplicateModal && (
        <div className="modal-overlay">
          <div className="glass-modal glass-modal-lg animate-float">
            <button
              onClick={() => {
                setShowDuplicateModal(false);
                resetImportModal();
              }}
              className="absolute top-6 right-6 text-slate-400 hover:text-slate-700 transition-colors"
            >
              <i className="fa-solid fa-xmark text-xl"></i>
            </button>

            <h3 className="text-2xl font-black text-slate-900 mb-2 tracking-tight">Duplicate Leads Detected</h3>
            <p className="text-xs font-medium text-slate-500 mb-6 uppercase tracking-widest">
              The following leads were skipped because they already exist in your database (based on phone number).
            </p>

            <div className="max-h-[60vh] overflow-y-auto mb-6">
              <div className="space-y-3">
                {duplicateLeads.map((duplicate, index) => (
                  <div
                    key={index}
                    className="p-4 rounded-xl border border-amber-200 bg-amber-50/50"
                  >
                    <div className="flex items-start gap-3">
                      <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <i className="fa-solid fa-exclamation-triangle text-amber-600 text-sm"></i>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-sm font-bold text-slate-900">
                            {duplicate.csvLead.first_name} {duplicate.csvLead.last_name}
                          </span>
                          <span className="text-xs text-slate-500">•</span>
                          <span className="text-xs font-semibold text-slate-600">
                            {duplicate.csvLead.phone}
                          </span>
                        </div>
                        {duplicate.csvLead.email && (
                          <div className="text-xs text-slate-500 mb-2">
                            Email: {duplicate.csvLead.email}
                          </div>
                        )}
                        <div className="text-xs text-slate-400 italic">
                          Already exists as: {duplicate.existingLead.first_name} {duplicate.existingLead.last_name}
                          {duplicate.existingLead.email && ` (${duplicate.existingLead.email})`}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-200">
              <button
                type="button"
                onClick={() => {
                  setShowDuplicateModal(false);
                  resetImportModal();
                }}
                className="px-8 py-3 rounded-xl bg-blue-600 text-white text-xs font-black uppercase tracking-[0.2em] shadow-lg shadow-blue-500/20 hover:bg-blue-700 transition-all"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {
        showDeleteModal && (
          <div className="modal-overlay">
            <div className="glass-modal glass-modal-sm animate-float">
              <button
                onClick={() => setShowDeleteModal(false)}
                className="absolute top-6 right-6 text-slate-400 hover:text-slate-700 transition-colors"
              >
                <i className="fa-solid fa-xmark text-xl"></i>
              </button>

              <h3 className="text-2xl font-black text-slate-900 mb-2 tracking-tight">Delete Leads</h3>
              <p className="text-xs font-medium text-slate-500 mb-6 uppercase tracking-widest">
                Select which leads you want to permanently remove.
              </p>

              <div className="space-y-6">
                <div>
                  <label className="glass-label">Select Status to Delete</label>
                  <div className="relative">
                    <select
                      value={deleteStatusFilter}
                      onChange={(e) => setDeleteStatusFilter(e.target.value)}
                      className="glass-input w-full rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 appearance-none cursor-pointer"
                    >
                      {STATUS_FILTERS.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                    <i className="fa-solid fa-chevron-down absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 text-xs pointer-events-none"></i>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-2">
                    Selecting "All" will delete <strong>every single lead</strong> in the database.
                  </p>
                </div>

                <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-200/50">
                  <button
                    type="button"
                    onClick={() => setShowDeleteModal(false)}
                    className="px-6 py-3 rounded-xl border border-slate-200/60 bg-white/50 text-xs font-bold uppercase tracking-wider text-slate-500 hover:bg-white hover:text-slate-800 hover:border-slate-300 transition-all shadow-sm"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleBulkDelete}
                    disabled={isDeleting}
                    className="px-8 py-3 rounded-xl bg-red-600 text-white text-xs font-black uppercase tracking-[0.15em] shadow-lg shadow-red-500/20 hover:bg-red-700 disabled:opacity-70 disabled:cursor-not-allowed flex items-center gap-2"
                  >
                    {isDeleting ? (
                      <>
                        <i className="fa-solid fa-circle-notch fa-spin"></i>
                        Deleting...
                      </>
                    ) : (
                      <>
                        <i className="fa-solid fa-trash-can"></i>
                        Delete {deleteStatusFilter === 'All' ? 'All' : deleteStatusFilter}
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      }

      {
        showLeadModal && (
          <div className="modal-overlay">
            <div className="glass-modal glass-modal-lg animate-float">
              <button
                onClick={() => setShowLeadModal(false)}
                className="absolute top-6 right-6 text-slate-400 hover:text-slate-700 transition-colors"
              >
                <i className="fa-solid fa-xmark text-xl"></i>
              </button>

              <h3 className="text-2xl font-black text-slate-900 mb-2 tracking-tight">Add New Lead</h3>
              <p className="text-xs font-medium text-slate-500 mb-8 uppercase tracking-widest">
                Provide the lead details below. Required fields are marked with <span className="text-red-500">*</span>.
              </p>

              <form onSubmit={handleCreateLead} className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <div>
                    <label className="glass-label">First Name <span className="text-red-500">*</span></label>
                    <input
                      type="text"
                      required
                      placeholder="John"
                      value={newLead.first_name}
                      onChange={(e) => handleNewLeadChange('first_name', e.target.value)}
                      className="glass-input w-full rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 placeholder:text-slate-400"
                    />
                  </div>
                  <div>
                    <label className="glass-label">Last Name</label>
                    <input
                      type="text"
                      placeholder="Doe"
                      value={newLead.last_name}
                      onChange={(e) => handleNewLeadChange('last_name', e.target.value)}
                      className="glass-input w-full rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 placeholder:text-slate-400"
                    />
                  </div>
                  <div>
                    <label className="glass-label">Email</label>
                    <input
                      type="email"
                      placeholder="john@example.com"
                      value={newLead.email}
                      onChange={(e) => handleNewLeadChange('email', e.target.value)}
                      className="glass-input w-full rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 placeholder:text-slate-400"
                    />
                  </div>
                  <div>
                    <label className="glass-label">Phone</label>
                    <input
                      type="tel"
                      placeholder="(555) 123-4567"
                      value={newLead.phone}
                      onChange={(e) => handleNewLeadChange('phone', e.target.value)}
                      className="glass-input w-full rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 placeholder:text-slate-400"
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="glass-label">Address</label>
                    <input
                      type="text"
                      placeholder="123 Main St"
                      value={newLead.address_line1}
                      onChange={(e) => handleNewLeadChange('address_line1', e.target.value)}
                      className="glass-input w-full rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 placeholder:text-slate-400"
                    />
                  </div>
                  <div>
                    <label className="glass-label">City</label>
                    <input
                      type="text"
                      placeholder="New York"
                      value={newLead.city}
                      onChange={(e) => handleNewLeadChange('city', e.target.value)}
                      className="glass-input w-full rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 placeholder:text-slate-400"
                    />
                  </div>
                  <div>
                    <label className="glass-label">State</label>
                    <input
                      type="text"
                      placeholder="NY"
                      value={newLead.state}
                      onChange={(e) => handleNewLeadChange('state', e.target.value)}
                      className="glass-input w-full rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 placeholder:text-slate-400"
                    />
                  </div>
                  <div>
                    <label className="glass-label">Postal Code</label>
                    <input
                      type="text"
                      placeholder="10001"
                      value={newLead.postal_code}
                      onChange={(e) => handleNewLeadChange('postal_code', e.target.value)}
                      className="glass-input w-full rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 placeholder:text-slate-400"
                    />
                  </div>
                  <div>
                    <label className="glass-label">Source</label>
                    <input
                      type="text"
                      placeholder="Manual Entry"
                      value={newLead.source}
                      onChange={(e) => handleNewLeadChange('source', e.target.value)}
                      className="glass-input w-full rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 placeholder:text-slate-400"
                    />
                  </div>
                  <div>
                    <label className="glass-label">Status</label>
                    <div className="relative">
                      <select
                        value={newLead.status}
                        onChange={(e) => handleNewLeadChange('status', e.target.value)}
                        className="glass-input w-full rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 appearance-none cursor-pointer"
                      >
                        {STATUS_FILTERS.filter((status) => status !== 'All').map((status) => (
                          <option key={status} value={status}>
                            {status}
                          </option>
                        ))}
                      </select>
                      <i className="fa-solid fa-chevron-down absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 text-xs pointer-events-none"></i>
                    </div>
                  </div>
                </div>

                <div>
                  <label className="glass-label">
                    Tags <span className="text-[9px] text-slate-400/70 normal-case tracking-normal">(comma separated)</span>
                  </label>
                  <input
                    type="text"
                    placeholder="hot, urgent, referral"
                    value={newLead.tags}
                    onChange={(e) => handleNewLeadChange('tags', e.target.value)}
                    className="glass-input w-full rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 placeholder:text-slate-400"
                  />
                </div>

                <div className="flex items-center justify-end gap-3 pt-6 border-t border-slate-200/50">
                  <button
                    type="button"
                    onClick={() => {
                      setShowLeadModal(false);
                      setNewLead({ ...INITIAL_LEAD_FORM });
                    }}
                    className="px-6 py-3 rounded-xl border border-slate-200/60 bg-white/50 text-xs font-bold uppercase tracking-wider text-slate-500 hover:bg-white hover:text-slate-800 hover:border-slate-300 transition-all shadow-sm"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isCreatingLead}
                    className="px-8 py-3 rounded-xl bg-black text-white text-xs font-black uppercase tracking-[0.15em] shadow-lg shadow-indigo-500/20 hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-70 disabled:cursor-not-allowed flex items-center gap-2"
                  >
                    {isCreatingLead ? (
                      <>
                        <i className="fa-solid fa-circle-notch fa-spin"></i>
                        Saving...
                      </>
                    ) : (
                      <>
                        <i className="fa-solid fa-check"></i>
                        Save Lead
                      </>
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )
      }

    </>
  );
}

