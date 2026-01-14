'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { supabase } from '@/utils/supabase/client';
import Papa from 'papaparse';
import WebPhone from '@/lib/ringcentral-webphone';
import { SDK } from '@ringcentral/sdk';
import Chart from 'chart.js/auto';

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

const DISPOSITION_OPTIONS = [
  'No Answer',
  'Voice Mail',
  'Left Voice Mail',
  'Call Back',
  'Do Not Call',
  'W# (Wrong Number)',
  'Not Interested',
  'Qualified',
] as const;

const STATUS_FILTERS = ['All', 'New', ...DISPOSITION_OPTIONS] as const;

const STATUS_QUERY_MAP: Record<string, string[]> = {
  All: [],
  New: ['New'],
  'No Answer': ['No Answer'],
  'Voice Mail': ['Voice Mail'],
  'Left Voice Mail': ['Left Voice Mail', 'Left Voicemail'],
  'Call Back': ['Call Back'],
  'Do Not Call': ['Do Not Call'],
  'W# (Wrong Number)': ['W# (Wrong Number)'],
  'Not Interested': ['Not Interested'],
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

// --- Overview Components ---

// --- Overview Components ---

function MetricCard({ title, value, subtext, icon, trend, colorClass }: { title: string; value: string | number; subtext: string; icon: string; trend?: { value: number; positive: boolean }; colorClass: string }) {
  return (
    <div className="glass-card-premium p-7 rounded-[2.5rem] flex flex-col justify-between h-full group relative overflow-hidden">
      <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-50/50 rounded-full blur-3xl -mr-16 -mt-16 group-hover:bg-indigo-100/50 transition-colors"></div>
      <div className="relative z-10 flex justify-between items-start mb-6">
        <div className={`w-14 h-14 ${colorClass} rounded-2xl flex items-center justify-center text-xl shadow-lg shadow-blue-900/5 transition-transform group-hover:scale-110 duration-500`}>
          <i className={`fa-solid ${icon}`}></i>
        </div>
        {trend && (
          <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl font-bold text-[10px] ${trend.positive ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}`}>
            <span className="flex h-1.5 w-1.5 rounded-full bg-current animate-pulse"></span>
            {trend.positive ? '↑' : '↓'} {Math.abs(trend.value)}%
          </div>
        )}
      </div>
      <div className="relative z-10">
        <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-[0.15em] mb-2">{title}</h4>
        <div className="flex items-baseline gap-2">
          <span className="text-4xl font-black text-slate-900 tracking-tighter">{value}</span>
        </div>
        <div className="mt-4 pt-4 border-t border-slate-100/50">
          <p className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider line-clamp-1 flex items-center gap-2">
            <i className="fa-solid fa-circle-info text-[8px] opacity-40"></i>
            {subtext}
          </p>
        </div>
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
              backgroundColor: "rgba(79, 70, 229, 0.8)",
              borderRadius: 6,
              hoverBackgroundColor: "rgba(79, 70, 229, 1)",
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { enabled: true, backgroundColor: '#0f172a', titleFont: { size: 10 }, bodyFont: { size: 10 }, padding: 10, cornerRadius: 10 } },
            scales: {
              y: { beginAtZero: true, grid: { display: false }, ticks: { display: false } },
              x: { grid: { display: false }, ticks: { font: { size: 9, weight: 'bold' }, color: '#94a3b8' } },
            },
          },
        });
      }
    }
    return () => chart?.destroy();
  }, [data]);

  return (
    <div className="glass-card-premium p-8 rounded-[2.5rem] flex flex-col h-full">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h3 className="text-sm font-black text-slate-900 tracking-tight uppercase">Interaction Density</h3>
          <p className="text-[10px] text-slate-400 font-bold mt-0.5">Live Engagement Mapping</p>
        </div>
        <div className="flex gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-indigo-500"></div>
          <div className="w-1.5 h-1.5 rounded-full bg-indigo-300"></div>
          <div className="w-1.5 h-1.5 rounded-full bg-indigo-100"></div>
        </div>
      </div>
      {!data || data.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-slate-400 text-xs font-bold uppercase tracking-widest italic">Streaming next data segment...</div>
      ) : (
        <div className="flex-1 min-h-[140px]"><canvas ref={chartRef}></canvas></div>
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
        const mainGradient = ctx.createLinearGradient(0, 0, 0, 300);
        mainGradient.addColorStop(0, "rgba(79, 70, 229, 0.08)");
        mainGradient.addColorStop(1, "rgba(255, 255, 255, 0)");

        chart = new Chart(ctx, {
          type: "line",
          data: {
            labels: data.map(d => d.label),
            datasets: [{
              label: "Leads",
              data: data.map(d => d.count),
              borderColor: "#4F46E5",
              borderWidth: 4,
              tension: 0.4,
              fill: true,
              backgroundColor: mainGradient,
              pointBackgroundColor: "#ffffff",
              pointBorderColor: "#4F46E5",
              pointBorderWidth: 2,
              pointRadius: 0,
              pointHoverRadius: 6,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              y: { beginAtZero: true, grid: { color: "#F1F5F9" }, ticks: { font: { size: 9 }, color: "#94A3B8" } },
              x: { grid: { display: false }, ticks: { font: { size: 9 }, color: "#94A3B8" } },
            },
          },
        });
      }
    }
    return () => chart?.destroy();
  }, [data]);

  return (
    <div className="glass-card-premium p-8 rounded-[2.5rem] flex-1 min-h-[380px] flex flex-col h-full text-left">
      <div className="flex items-center justify-between mb-10">
        <div>
          <h3 className="text-base font-black text-slate-900 tracking-tight uppercase">Capture Velocity</h3>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">Acquisition Index (7D)</p>
        </div>
        <div className="px-4 py-2 bg-slate-50 rounded-2xl border border-slate-100">
          <span className="text-[10px] font-black text-indigo-600 uppercase tracking-widest">Real-time Feed</span>
        </div>
      </div>
      <div className="flex-1"><canvas ref={chartRef}></canvas></div>
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
              backgroundColor: ["#4F46E5", "#3B82F6", "#F59E0B", "#F1F5F9"],
              borderWidth: 0,
              borderRadius: 10,
              spacing: 4,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: "80%",
            plugins: { legend: { display: false } },
            animation: { animateRotate: true, duration: 1500 },
          },
        });
      }
    }
    return () => chart?.destroy();
  }, [metrics]);

  return (
    <div className="glass-card-premium p-8 rounded-[2.5rem] w-full lg:w-[320px] shrink-0 flex flex-col h-full text-left">
      <div className="mb-8">
        <h3 className="text-base font-black text-slate-900 tracking-tight uppercase">Portfolio</h3>
        <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">Yield Segmentation</p>
      </div>
      <div className="relative flex-1 min-h-[180px] mb-8">
        <canvas ref={chartRef}></canvas>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <p className="text-4xl font-black text-slate-900 tracking-tighter text-center">
            {metrics.totalLeads > 0 ? Math.round((metrics.qualifiedLeads / metrics.totalLeads) * 100) : 0}%
          </p>
          <p className="text-[9px] font-black text-indigo-500 uppercase tracking-widest">Global Yield</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 pt-6 border-t border-slate-100">
        <div className="bg-slate-50/80 p-4 rounded-3xl border border-slate-100 flex flex-col items-center">
          <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1 text-center">Conversion</p>
          <p className="text-sm font-black text-slate-900 tracking-tight">{metrics.conversionRate}%</p>
        </div>
        <div className="bg-slate-900 p-4 rounded-3xl flex flex-col items-center">
          <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-1 text-center">Target</p>
          <p className="text-sm font-black text-white tracking-tight">12.0%</p>
        </div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [activeView, setActiveView] = useState<'overview' | 'dialer' | 'contacts'>('overview');
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
  const [isTagSaving, setIsTagSaving] = useState(false);
  const [pageCursors, setPageCursors] = useState<Record<number, { created_at: string; id: string } | null>>({});
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteStatusFilter, setDeleteStatusFilter] = useState<string>('All');
  const [isDeleting, setIsDeleting] = useState(false);
  const [selectedDisposition, setSelectedDisposition] = useState<string>('');
  const [itemsPerPage, setItemsPerPage] = useState(50);
  const [isSubmittingDisposition, setIsSubmittingDisposition] = useState(false);
  const [webPhone, setWebPhone] = useState<WebPhone | null>(null);
  const [webPhoneReady, setWebPhoneReady] = useState(false);
  const [webPhoneStatus, setWebPhoneStatus] = useState('Initializing...');
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
      const { data, error } = await supabase
        .from('lead_activities')
        .select('*')
        .eq('lead_id', leadId)
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) {
        console.error('Error fetching activities:', error);
        throw error;
      }

      console.log('Fetched activities:', data);

      // Normalize activities to ensure activity_type is set (fallback to 'type' if activity_type doesn't exist)
      const normalizedActivities = (data || []).map((activity: any) => ({
        ...activity,
        activity_type: activity.activity_type || activity.type?.toLowerCase() || 'unknown',
      }));

      console.log('Normalized activities:', normalizedActivities);
      setLeadActivities(normalizedActivities);
    } catch (error) {
      console.error('Error fetching activities:', error);
      setLeadActivities([]);
    }
  }, []);

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

    // Fetch activities when active lead changes
    if (activeLead?.id) {
      fetchLeadActivities(activeLead.id);
    } else {
      setLeadActivities([]);
    }
  }, [activeLead?.id, fetchLeadActivities]);

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

  const handleDownloadAllRecordings = async () => {
    if (!rcToken) {
      // Request token if we don't have it yet
      const iframe = document.querySelector("#rc-widget") as HTMLIFrameElement;
      iframe?.contentWindow?.postMessage({
        type: 'rc-adapter-register-service',
        service: 'RcAdapter',
      }, '*');
      alert('Please wait for the dialer to fully load and try again in a few seconds.');
      return;
    }

    if (!confirm('This will download all recordings and voicemails (last 90 days) directly from RingCentral. Continue?')) return;

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
        alert('No recordings or voicemails found.');
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
      alert('An error occurred during download.');
      setIsDownloadingRecordings(false);
    }
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
        const server = process.env.NEXT_PUBLIC_RC_SERVER || 'https://platform.ringcentral.com';
        const jwt = process.env.NEXT_PUBLIC_RC_JWT;

        if (!clientId || !clientSecret || !jwt) {
          setWebPhoneStatus('Error: RingCentral credentials not configured. Please set NEXT_PUBLIC_RC_CLIENT_ID, NEXT_PUBLIC_RC_CLIENT_SECRET, and NEXT_PUBLIC_RC_JWT in your environment variables.');
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

        await platform.login({
          jwt: jwt.trim(),
        });

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
          logLevel: 1, // Reduced logging for production
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
              const duration = callStartTime
                ? Math.floor((new Date().getTime() - callStartTime.getTime()) / 1000)
                : 0;

              console.log('Saving incoming call terminated activity:', {
                leadId: activeLead.id,
                duration,
              });

              saveActivity(
                activeLead.id,
                'call',
                `Incoming call ended${duration > 0 ? ` - Duration: ${formatCallDuration(duration)}` : ''}`,
                {
                  duration_seconds: duration,
                  call_type: 'inbound',
                }
              );
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
        console.error('Failed to initialize WebPhone:', error);
        setWebPhoneStatus(`Error: ${error.message || 'Initialization failed'}`);
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
          const duration = callStartTime
            ? Math.floor((new Date().getTime() - callStartTime.getTime()) / 1000)
            : 0;

          saveActivity(
            leadToDial.id,
            'call',
            `Call ended${duration > 0 ? ` - Duration: ${formatCallDuration(duration)}` : ''}`,
            {
              duration_seconds: duration,
              phone_number: leadToDial.phone,
              call_type: 'outbound',
            }
          );
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
  const startPowerDialing = useCallback(async (leadsOverride?: Lead[]) => {
    if (!webPhone || !webPhoneReady) {
      alert('WebPhone is not ready. Please wait for initialization.');
      return;
    }

    if (isPowerDialing) {
      // Stop power dialing
      setIsPowerDialing(false);
      setPowerDialingIndex(0);
      setPowerDialingLeads([]);
      powerDialingQueueSnapshotRef.current = []; // Clear the snapshot
      isManuallyAdvancingRef.current = false; // Clear the flag
      isManuallyAdvancingRef.current = false; // Clear the flag
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
      return;
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
        // No leads selected - apply status filter as primary filter
        let query = supabase.from('leads').select('*');

        // Apply status filter - this is the PRIMARY filter that determines what gets dialed
        if (statusFilter !== 'All') {
          const statusesToMatch = STATUS_QUERY_MAP[statusFilter] ?? [statusFilter];
          if (statusesToMatch.length === 1) {
            query = query.eq('status', statusesToMatch[0]);
          } else if (statusesToMatch.length > 1) {
            query = query.in('status', statusesToMatch);
          }
        }

        // Apply date filter if set
        if (dateFilterMode === 'today') {
          const { start, end } = getDayRange(new Date());
          query = query.gte('created_at', start).lt('created_at', end);
        } else if (dateFilterMode === 'last3') {
          const end = new Date();
          const start = new Date();
          start.setDate(start.getDate() - 3);
          query = query.gte('created_at', start.toISOString()).lte('created_at', end.toISOString());
        } else if (dateFilterMode === 'week') {
          const { start, end } = getLastNDaysRange(7);
          query = query.gte('created_at', start).lt('created_at', end);
        } else if (dateFilterMode === 'month') {
          const start = new Date();
          start.setDate(1);
          start.setHours(0, 0, 0, 0);
          const end = new Date(start);
          end.setMonth(end.getMonth() + 1);
          query = query.gte('created_at', start.toISOString()).lt('created_at', end.toISOString());
        } else if (dateFilterMode === 'date' && selectedDate) {
          const { start, end } = getDayRange(new Date(selectedDate));
          query = query.gte('created_at', start).lt('created_at', end);
        } else if (dateFilterMode === 'customMonth' && selectedMonth) {
          const { start, end } = getMonthRange(selectedMonth);
          query = query.gte('created_at', start).lt('created_at', end);
        }

        // Apply view mode filter
        if (viewMode === 'untouched') {
          const processedList = PROCESSED_STATUS_DB_VALUES.map((status) =>
            `"${status.replace(/"/g, '\\"')}"`
          ).join(',');
          if (processedList) {
            query = query.not('status', 'in', `(${processedList})`);
          }
        }

        // Fetch all matching leads (not just current page)
        let allFilteredLeads: Lead[] = [];
        let page = 1;
        let hasMore = true;

        while (hasMore) {
          const pageFrom = (page - 1) * 1000;
          const pageTo = pageFrom + 999;

          const pageQuery = query.range(pageFrom, pageTo).order('created_at', { ascending: false });
          const { data, error } = await pageQuery;

          if (error) throw error;

          const pageLeads = data || [];
          allFilteredLeads = [...allFilteredLeads, ...pageLeads];

          hasMore = pageLeads.length === 1000;
          page++;
        }

        leadsToDial = allFilteredLeads;
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
          alert('No selected leads have phone numbers.');
        } else if (selectedLeads.size > 0) {
          alert('No selected leads have phone numbers.');
        } else {
          alert(`No leads with phone numbers found for status "${statusFilter}".`);
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
              alert('Media elements not ready. Please refresh the page.');
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

              // Calculate call duration and save activity (always save, even if duration is 0)
              if (firstLead?.id) {
                const duration = callStartTime
                  ? Math.floor((new Date().getTime() - callStartTime.getTime()) / 1000)
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
                  }
                );
              }

              setCallStartTime(null);
              setCurrentCall(null);
              currentCallRef.current = null;
            });

            session.on('rejected', () => {
              setWebPhoneStatus('Call rejected');

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
      alert('Failed to start power dialing. Please try again.');
      setLoading(false);
    }
  }, [webPhone, webPhoneReady, isPowerDialing, currentCall, selectedLeads, statusFilter, dateFilterMode, selectedDate, selectedMonth, viewMode]);

  // Move to next lead after call ends (when power dialing)
  useEffect(() => {
    // Only check flag at the start - if it's set, skip this run
    // But allow it to proceed if flag gets cleared during the timeout
    const wasManuallyAdvancing = isManuallyAdvancingRef.current;
    
    if (isPowerDialing && !currentCall && powerDialingQueueSnapshotRef.current.length > 0 && powerDialingIndex < powerDialingQueueSnapshotRef.current.length && webPhone && webPhoneReady) {
      // If we were manually advancing, wait a bit longer to see if it completes
      const delay = wasManuallyAdvancing ? 1000 : 3000;
      
      // Call just ended naturally (not from manual advancement), wait a moment then move to next lead
      const timer = setTimeout(() => {
        // Check flag again - if it's still set, skip (manual advancement is in progress)
        // But if it was cleared, proceed with auto-advance
        if (isManuallyAdvancingRef.current) {
          console.log('useEffect: Skipping auto-advance - manual advancement still in progress');
          return;
        }
        
        // If flag was set but is now cleared, it means manual advancement completed and dial started
        // The currentCall check below will prevent duplicate dialing, so we can proceed
        if (wasManuallyAdvancing && isManuallyAdvancingRef.current === false) {
          console.log('useEffect: Manual advancement completed, proceeding with auto-advance (currentCall check will prevent duplicates)');
        }
        // CRITICAL: Use the IMMUTABLE snapshot from ref - this is the source of truth
        const snapshot = powerDialingQueueSnapshotRef.current;
        const nextIndex = powerDialingIndex + 1;
        console.log('useEffect: Moving to next lead. Index:', nextIndex, 'Snapshot length:', snapshot.length);

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

                  // Calculate call duration and save activity (always save, even if duration is 0)
                  if (nextLead?.id) {
                    const duration = callStartTime
                      ? Math.floor((new Date().getTime() - callStartTime.getTime()) / 1000)
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
                      }
                    );
                  }

                  setCallStartTime(null);
                  setCurrentCall(null);
                currentCallRef.current = null;
                });

                session.on('rejected', () => {
                  setWebPhoneStatus('Call rejected');

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
                isManuallyAdvancingRef.current = false; // Clear flag on error
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
              // Clear flag if conditions aren't met
              isManuallyAdvancingRef.current = false;
            }
          }, 2000);
        } else {
          // Finished all leads
          const totalDialed = powerDialingQueueSnapshotRef.current.length;
          setIsPowerDialing(false);
          setPowerDialingIndex(0);
          setPowerDialingLeads([]);
          powerDialingQueueSnapshotRef.current = [];
          isManuallyAdvancingRef.current = false; // Clear the flag
          setWebPhoneStatus('Power dialing complete');
          alert(`Power dialing complete! Dialed ${totalDialed} leads.`);
        }
      }, 3000); // Wait 3 seconds after call ends before next dial

      return () => clearTimeout(timer);
    }
  }, [currentCall, isPowerDialing, powerDialingIndex, powerDialingLeads, webPhone, webPhoneReady]);

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
      const { data: leads, error } = await supabase.from("leads").select("status, created_at");
      if (error) throw error;

      const total = leads.length;
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
      const discardedCount = leads.filter(l => ["Not Interested", "Do Not Call", "W# (Wrong Number)"].includes(l.status)).length;
      const pendingCount = leads.filter(l => ["Call Back", "Voice Mail", "Left Voice Mail"].includes(l.status)).length;

      const conversion = total > 0 ? (qualifiedCount / total) * 100 : 0;

      const growthValue = yesterdayLeads.length > 0
        ? ((todayLeads.length - yesterdayLeads.length) / yesterdayLeads.length) * 100
        : todayLeads.length > 0 ? 100 : 0;

      // Generate activity heatmap (24 hours, default to 0)
      const heatmap = Array.from({ length: 24 }, (_, i) => ({
        hour: i,
        count: 0, // TODO: Calculate actual activity count per hour
      }));

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
        callsToday: 0, // TODO: Calculate actual calls today
        avgDuration: 0, // TODO: Calculate actual average duration
      });
    } catch (err) {
      console.error("Error fetching metrics:", err);
    }
  }, []);

  useEffect(() => {
    if (activeView === 'overview') {
      fetchDashboardMetrics();
    }
  }, [activeView, fetchDashboardMetrics]);

  // Save activity to database
  const saveActivity = async (leadId: string, activityType: string, description: string, metadata?: any) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        console.warn('No user found, cannot save activity');
        return;
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

      // If lead doesn't have a user_id, set it to current user (for RLS policy)
      if (!leadData.user_id) {
        console.log('Lead has no user_id, setting to current user...');
        const { error: updateError } = await supabase
          .from('leads')
          .update({ user_id: user.id })
          .eq('id', leadId);

        if (updateError) {
          console.error('Failed to set user_id on lead:', updateError);
          return;
        }
      } else if (leadData.user_id !== user.id) {
        console.error('Lead does not belong to current user. Lead user_id:', leadData.user_id, 'Current user:', user.id);
        return;
      }

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
      const activityData: any = {
        lead_id: leadId,
        activity_type: activityType,
        type: typeMapping[activityType.toLowerCase()] || activityType.toUpperCase(), // Old column requires uppercase and NOT NULL
        description,
        metadata: metadata || {},
        created_by: user.id,
      };

      console.log('Saving activity:', {
        leadId,
        activityType,
        description,
        metadata,
        activityData,
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
      if (activeLead?.id === leadId) {
        console.log('Refreshing activities after save for lead:', leadId);
        // Add a small delay to ensure the database has committed the transaction
        setTimeout(async () => {
          await fetchLeadActivities(leadId);
        }, 500);
      } else {
        console.log('Active lead ID does not match:', activeLead?.id, 'vs', leadId);
      }
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
  // This should reflect the actual count of leads matching the current status filter
  const eligiblePowerDialCount = useMemo(() => {
    // When status filter is active, use totalLeads which is updated by fetchLeads
    if (statusFilter !== 'All') {
      // If we have all filtered leads on current page, count directly for immediate accuracy
      if (leads.length < itemsPerPage && leads.length > 0) {
        // Verify all leads match the filter and count them
        const statusesToMatch = STATUS_QUERY_MAP[statusFilter] ?? [statusFilter];
        const matchingLeads = leads.filter(lead =>
          statusesToMatch.includes(lead.status || '')
        );
        // Use the direct count if it's available, otherwise fall back to totalLeads
        return matchingLeads.length > 0 ? matchingLeads.length : totalLeads;
      }

      // For paginated results, use totalLeads which should be accurate
      // fetchLeads updates it when statusFilter changes via useEffect
      return totalLeads;
    }

    // For "All" status, estimate from current page
    const leadsWithPhoneOnPage = leads.filter(lead =>
      lead.phone && lead.phone.trim()
    ).length;

    // If we have all leads on current page, count directly
    if (leads.length < itemsPerPage && leads.length > 0) {
      return leadsWithPhoneOnPage;
    }

    // For paginated "All" results, estimate based on ratio
    if (leads.length > 0 && totalLeads > 0) {
      const phoneRatio = leadsWithPhoneOnPage / leads.length;
      return Math.round(totalLeads * phoneRatio);
    }

    // Fallback: use totalLeads
    return totalLeads;
  }, [leads, totalLeads, itemsPerPage, statusFilter]);

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
  };

  const handleLeadPhoneClick = (e: React.MouseEvent, lead: Lead) => {
    e.stopPropagation();
    setActiveLead(lead);
    setActiveView('dialer');
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

  const handleSubmitDisposition = async (overrideDisposition?: string, fromIRSLogicsButton: boolean = false) => {
    if (!activeLead) return;

    const dispositionToUse = overrideDisposition || selectedDisposition;
    if (!dispositionToUse || dispositionToUse.trim() === '') {
      alert('Please select a disposition before submitting.');
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
      const statusToSave = getPrimaryStatusValue(dispositionToUse);

      // Only proceed if status is actually changing (unless it's from IRSLogics button during power dialing)
      const statusChanged = oldStatus !== statusToSave;
      if (!statusChanged && !(fromIRSLogicsButton && isPowerDialing)) {
        // If status hasn't changed and it's not from IRSLogics button during power dialing, show alert
        if (!fromIRSLogicsButton) {
          alert('Status is already set to this value.');
        }
        // If it's from IRSLogics button during power dialing and status hasn't changed,
        // we still want to proceed to move to next call, so don't return here
        if (!isPowerDialing || !fromIRSLogicsButton) {
          setIsSubmittingDisposition(false);
          return;
        }
      }

      // Update lead status only if it changed
      if (statusChanged) {
        const { error } = await supabase
          .from('leads')
          .update({ status: statusToSave })
          .eq('id', activeLead.id);
        if (error) throw error;

        // Save activity for disposition change (only if status changed)
        await saveActivity(
          activeLead.id,
          'disposition_change',
          `Status changed from "${formatStatusForDisplay(oldStatus)}" to "${formatStatusForDisplay(statusToSave)}"`,
          {
            old_status: oldStatus,
            new_status: statusToSave,
            old_status_display: formatStatusForDisplay(oldStatus),
            new_status_display: formatStatusForDisplay(statusToSave),
          }
        );

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

      // If power dialing is active, end the call and move to next lead
      // BUT: If the new status is "Qualified" and NOT from IRSLogics button, don't auto-advance - wait for IRSLogics button click
      const isQualifiedStatus = statusToSave === 'Qualified' || statusToSave === 'Qualified Lead';
      if (isPowerDialing && currentCall && activeLead?.id && (fromIRSLogicsButton || !isQualifiedStatus)) {
        try {
          // Save call activity with duration before ending
          if (callStartTime) {
            const duration = Math.floor((new Date().getTime() - callStartTime.getTime()) / 1000);
            await saveActivity(
              activeLead.id,
              'call',
              `Call ended - Duration: ${formatCallDuration(duration)}`,
              {
                duration_seconds: duration,
                phone_number: activeLead.phone,
                call_type: 'outbound',
              }
            );
          }

          // End the current call
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

          setCallStartTime(null);
          setCurrentCall(null);
          currentCallRef.current = null;
          setWebPhoneStatus('Call ended');

          // Move to next lead and auto-dial
          // CRITICAL: Set flag to prevent useEffect from also trying to advance
          isManuallyAdvancingRef.current = true;

          // Use the snapshot ref as source of truth
          const snapshot = powerDialingQueueSnapshotRef.current;
          const nextIndex = powerDialingIndex + 1;
          console.log('handleSubmitDisposition: Moving to next lead. Index:', nextIndex, 'Snapshot length:', snapshot.length);

          if (nextIndex < snapshot.length) {
            setPowerDialingIndex(nextIndex);
            const nextLead = snapshot[nextIndex];
            if (!nextLead) {
              console.error('CRITICAL ERROR: Next lead not found at index', nextIndex, 'in snapshot array of length', snapshot.length);
              console.error('Snapshot contents:', snapshot.map((l, i) => ({ index: i, id: l.id, name: `${l.first_name} ${l.last_name}` })));
              setIsPowerDialing(false);
              setPowerDialingLeads([]);
              powerDialingQueueSnapshotRef.current = [];
              isManuallyAdvancingRef.current = false;
              setWebPhoneStatus('Error: Lead not found in queue');
              return;
            }
            console.log('handleSubmitDisposition: Setting next lead from snapshot:', nextLead.id, `${nextLead.first_name} ${nextLead.last_name}`, 'Phone:', nextLead.phone);
            setActiveLead(nextLead);

            // Auto-dial the next lead after a short delay
            setTimeout(async () => {
              // Use ref to check currentCall (avoids closure issues)
              const hasActiveCall = currentCallRef.current !== null;
              if (nextLead?.phone && webPhone && webPhoneReady && !hasActiveCall) {
                try {
                  // Clear the flag immediately when dial starts - this allows useEffect to work for future calls
                  isManuallyAdvancingRef.current = false;
                  console.log('handleSubmitDisposition: Cleared manual advancement flag - dial starting');
                  
                  // Use snapshot length for accurate count
                  setWebPhoneStatus(`Dialing ${nextLead.phone}... (${nextIndex + 1}/${snapshot.length})`);
                  console.log(`handleSubmitDisposition: Dialing lead ${nextIndex + 1} of ${snapshot.length} from snapshot`);
                  const cleanNumber = nextLead.phone.replace(/\D/g, '');
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

                    // Calculate call duration and save activity (always save, even if duration is 0)
                    if (nextLead?.id) {
                      const duration = callStartTime
                        ? Math.floor((new Date().getTime() - callStartTime.getTime()) / 1000)
                        : 0;

                      saveActivity(
                        nextLead.id,
                        'call',
                        `Call ended${duration > 0 ? ` - Duration: ${formatCallDuration(duration)}` : ''}`,
                        {
                          duration_seconds: duration,
                          phone_number: nextLead.phone,
                          call_type: 'outbound',
                        }
                      );
                    }

                    setCallStartTime(null);
                    setCurrentCall(null);
                currentCallRef.current = null;
                  });

                  session.on('rejected', () => {
                    setWebPhoneStatus('Call rejected');

                    if (nextLead?.id) {
                      const duration = callStartTime
                        ? Math.floor((new Date().getTime() - callStartTime.getTime()) / 1000)
                        : 0;

                      saveActivity(
                        nextLead.id,
                        'call',
                        `Call rejected${duration > 0 ? ` - Duration: ${formatCallDuration(duration)}` : ''}`,
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

                    if (nextLead?.id) {
                      const duration = callStartTime
                        ? Math.floor((new Date().getTime() - callStartTime.getTime()) / 1000)
                        : 0;

                      saveActivity(
                        nextLead.id,
                        'call',
                        `Call failed${duration > 0 ? ` - Duration: ${formatCallDuration(duration)}` : ''}`,
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
                  console.error('handleSubmitDisposition: Failed to dial next lead:', error);
                  setWebPhoneStatus(`Dial failed: ${error.message || 'Unknown error'}`);
                  setCurrentCall(null);
                currentCallRef.current = null;
                  isManuallyAdvancingRef.current = false; // Clear flag on error
                }
              } else {
                console.warn('handleSubmitDisposition: Auto-dial conditions not met - call not started:', {
                  hasPhone: !!nextLead?.phone,
                  phone: nextLead?.phone,
                  hasWebPhone: !!webPhone,
                  webPhoneReady,
                  hasCurrentCall: !!currentCall,
                  nextIndex,
                  snapshotLength: snapshot.length
                });
                // Clear flag if conditions aren't met
                isManuallyAdvancingRef.current = false;
              }
            }, 1500); // Wait 1.5 seconds before dialing next lead
          } else {
            // Finished all leads
            setIsPowerDialing(false);
            setPowerDialingIndex(0);
            const totalDialed = powerDialingQueueSnapshotRef.current.length;
            setPowerDialingLeads([]);
            powerDialingQueueSnapshotRef.current = [];
            isManuallyAdvancingRef.current = false; // Clear the flag
            setWebPhoneStatus('Power dialing complete');
            alert(`Power dialing complete! Dialed ${totalDialed} leads.`);
          }
        } catch (error: any) {
          console.error('Error ending call in power dialer:', error);
          // Still clear the call state
          setCurrentCall(null);
          currentCallRef.current = null;
          setCallStartTime(null);
        }
      } else {
        alert('Disposition saved successfully!');
      }
    } catch (err) {
      console.error('Failed to update disposition:', err);
      alert('Failed to update disposition. Please try again.');
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
      alert('Lead created successfully!');
    } catch (err) {
      console.error('Failed to create lead:', err);
      alert('Failed to create lead. Please try again.');
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
            alert('You must be logged in to upload leads.');
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

          const { error } = await supabase.from('leads').insert(parsedLeads);

          if (error) throw error;

          alert(`Successfully imported ${parsedLeads.length} leads!`);
          resetPaginationState();
          await fetchLeads();
          resetImportModal();
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
    if (!confirm(`Are you sure you want to delete leads with status: ${deleteStatusFilter}? This action cannot be undone.`)) {
      return;
    }

    setIsDeleting(true);
    try {
      let query = supabase.from('leads').delete();

      if (deleteStatusFilter !== 'All') {
        const statusesToDelete = STATUS_QUERY_MAP[deleteStatusFilter] ?? [deleteStatusFilter];
        if (statusesToDelete.length === 1) {
          query = query.eq('status', statusesToDelete[0]);
        } else {
          query = query.in('status', statusesToDelete);
        }
      } else {
        // To delete all, we need a condition that matches everything. neq id 0 is a safe bet for UUIDs
        query = query.neq('id', '00000000-0000-0000-0000-000000000000');
      }

      const { error } = await query;
      if (error) throw error;

      setShowDeleteModal(false);
      setDeleteStatusFilter('All');
      resetPaginationState();
      await fetchLeads();
      alert('Leads deleted successfully');
    } catch (err) {
      console.error('Error deleting leads:', err);
      alert('Failed to delete leads');
    } finally {
      setIsDeleting(false);
    }
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
      alert('Failed to add tag. Please try again.');
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
      alert('Failed to remove tag. Please try again.');
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
      <div className="bg-[#F8FAFC] text-slate-900 h-screen overflow-hidden flex" style={{ fontFamily: "var(--font-geist-sans), 'Inter', sans-serif" }}>
        <style>{`
          :root {
            --p-indigo: #4F46E5;
            --p-slate-900: #0F172A;
            --p-slate-50: #F8FAFC;
            --p-accent: #6366f1;
          }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #E2E8F0; border-radius: 10px; }
        ::-webkit-scrollbar-thumb:hover { background: #CBD5E1; }
        .active-ring { box-shadow: 0 0 0 2px #4F46E5, 0 0 0 4px rgba(79, 70, 229, 0.1); }
        .checkbox-custom:checked { background-color: #4F46E5; border-color: #4F46E5; }
        
        /* Glass Modal Styles */
        .glass-modal {
          background: rgba(255, 255, 255, 0.8);
          backdrop-filter: blur(24px) saturate(200%);
          border: 1px solid rgba(255, 255, 255, 0.4);
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.1);
        }
        .glass-panel {
          background: #ffffff;
          border: 1px solid #F1F5F9;
          box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.01), 0 1px 2px -1px rgba(0, 0, 0, 0.01);
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .glass-panel:hover {
          box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.04), 0 4px 6px -4px rgba(0, 0, 0, 0.04);
          border-color: #E2E8F0;
        }
        
        .glass-card-premium {
          background: rgba(255, 255, 255, 0.7);
          backdrop-filter: blur(16px);
          border: 1px solid rgba(255, 255, 255, 0.5);
          box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.04);
          transition: all 0.4s ease;
        }
        .glass-card-premium:hover {
          transform: translateY(-5px);
          box-shadow: 0 12px 40px 0 rgba(31, 38, 135, 0.08);
          border-color: rgba(99, 102, 241, 0.2);
        }

        .text-gradient-indigo {
          background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }

        @keyframes pulse-soft {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.8; transform: scale(1.05); }
        }
        .animate-pulse-soft { animation: pulse-soft 3s infinite ease-in-out; }

        .glass-input {
          background: rgba(248, 250, 252, 0.8);
          border: 1px solid #E2E8F0;
          transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .glass-input:focus {
          background: #ffffff;
          border-color: var(--p-indigo);
          box-shadow: 0 0 0 1px var(--p-indigo);
          outline: none;
        }
        .glass-label {
          font-size: 11px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: #64748B;
          margin-bottom: 6px;
          display: block;
        }

        .btn-premium {
          transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
          box-shadow: 0 1px 2px rgba(0,0,0,0.05);
        }
        .btn-premium:hover {
          transform: translateY(-1px);
          box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06);
        }
        .btn-premium:active {
          transform: translateY(0px);
        }
        .chart-container-premium {
          filter: drop-shadow(0 4px 6px rgba(0, 0, 0, 0.02));
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

        {/* 1. LEFT NAVIGATION (SLIMMER & MORE MODERN) */}
        <aside className="w-64 bg-slate-950 text-white flex flex-col shrink-0 border-r border-white/10">
          <div className="h-16 flex items-center px-6 mb-4">
            <span className="font-bold tracking-tight text-lg">Integrated <span className="text-blue-400">Financial</span></span>
          </div>

          <nav className="px-4 space-y-1">
            <button
              onClick={() => setActiveView('overview')}
              className={`w-full flex items-center space-x-3 px-3 py-2 rounded-xl transition-all ${activeView === 'overview'
                ? 'bg-blue-600/10 text-blue-400 border border-blue-600/20'
                : 'text-slate-400 hover:bg-white/5 hover:text-white'
                }`}
            >
              <i className="fa-solid fa-house-chimney w-5"></i> <span className="font-medium text-sm">Overview</span>
            </button>

            <button
              onClick={() => setActiveView('dialer')}
              className={`w-full flex items-center space-x-3 px-3 py-2 rounded-xl transition-all ${activeView === 'dialer'
                ? 'bg-blue-600/10 text-blue-400 border border-blue-600/20'
                : 'text-slate-400 hover:bg-white/5 hover:text-white'
                }`}
            >
              <i className="fa-solid fa-headset w-5"></i> <span className="font-medium text-sm">Power Dialer</span>
            </button>

            <button
              onClick={() => setActiveView('contacts')}
              className={`w-full flex items-center space-x-3 px-3 py-2 rounded-xl transition-all ${activeView === 'contacts'
                ? 'bg-blue-600/10 text-blue-400 border border-blue-600/20'
                : 'text-slate-400 hover:bg-white/5 hover:text-white'
                }`}
            >
              <i className="fa-solid fa-user-group w-5 text-sm"></i> <span className="font-medium text-sm">Contacts</span>
            </button>



            {/* <a href="#" className="flex items-center space-x-3 px-3 py-2 text-slate-400 hover:bg-white/5 hover:text-white rounded-xl transition-all">
            <i className="fa-solid fa-layer-group w-5 text-sm"></i> <span className="font-medium text-sm">Pipelines</span>
          </a>
          <a href="#" className="flex items-center space-x-3 px-3 py-2 text-slate-400 hover:bg-white/5 hover:text-white rounded-xl transition-all">
            <i className="fa-solid fa-calendar-check w-5 text-sm"></i> <span className="font-medium text-sm">Appointments</span>
          </a>
          <a href="#" className="flex items-center space-x-3 px-3 py-2 text-slate-400 hover:bg-white/5 hover:text-white rounded-xl">
            <i className="fa-solid fa-chart-column w-5 text-sm"></i> <span className="font-medium text-sm">Reporting</span>
          </a> */}
          </nav>

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

            return (
              <div className="mt-8 px-4 flex-1 overflow-y-auto no-scrollbar">
                <div className="flex items-center justify-between px-3 mb-6">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] uppercase font-bold tracking-[0.2em] text-slate-400">Live Queue</span>
                  </div>
                  <span className="text-[10px] bg-slate-800 text-blue-400 px-2 py-0.5 rounded-md font-bold border border-white/5">
                    {remainingCount} REMAINING
                  </span>
                </div>

                <div className="space-y-6">
                  {/* History (Past items) */}
                  {historyLeads.length > 0 && (
                    <div className="space-y-2 opacity-30">
                      {historyLeads.map((lead) => (
                        <div key={lead.id} className="px-3 py-2 rounded-lg border border-white/5 bg-white/5">
                          <p className="text-[10px] font-mono text-slate-400">{lead.phone}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Active Item */}
                  {activeItem && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 px-3">
                        <span className="text-[9px] font-black uppercase tracking-[0.2em] text-blue-500">Active Session</span>
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
                          <span className="text-[9px] text-blue-100 font-bold uppercase tracking-widest">In Progress</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Next Items */}
                  {nextItems.length > 0 && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 px-3 pt-2">
                        <span className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-500">Next</span>
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
                                <h5 className="text-[12px] font-semibold text-slate-200 group-hover:text-white transition-colors">
                                  {lead.first_name} {lead.last_name}
                                </h5>
                                <p className="text-[10px] text-slate-500 font-mono mt-0.5 group-hover:text-slate-400">{lead.phone}</p>
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
        </aside>

        {/* VIEW: OVERVIEW */}
        {activeView === 'overview' && (
          <main className="flex-1 p-8 lg:p-12 overflow-y-auto bg-[#F8FAFC]">
            <header className="max-w-7xl mx-auto flex justify-between items-end mb-12">
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2 px-3 py-1 bg-white border border-slate-100 rounded-full shadow-sm">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                    <span className="text-[10px] font-black text-slate-700 uppercase tracking-widest">System Active</span>
                  </div>
                  <span className="text-slate-300">/</span>
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Dashboard Hub</span>
                </div>
                <h1 className="text-4xl font-black tracking-tighter text-slate-900 leading-none">
                  Integrated Financial <span className="font-extralight italic text-slate-400">OS</span>
                </h1>
              </div>

              <div className="hidden lg:flex items-center gap-8 pb-1">
                <div className="text-right text-left">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 text-left">Network Health</p>
                  <p className="text-sm font-black text-slate-900 flex items-center justify-start gap-2">
                    Operational
                  </p>
                </div>
                <div className="h-10 w-px bg-slate-100"></div>
                <div className="text-right text-left">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 text-left">Last Sync</p>
                  <p className="text-sm font-black text-indigo-600">Just Now</p>
                </div>
              </div>
            </header>

            <div className="max-w-7xl mx-auto space-y-8">
              {/* STATUS ROW */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                <MetricCard
                  title="Total Universe"
                  value={metrics.totalLeads.toLocaleString()}
                  subtext="Global Distribution Index"
                  icon="fa-globe"
                  trend={{ value: metrics.growth, positive: metrics.growth >= 0 }}
                  colorClass="bg-indigo-50 text-indigo-600"
                />
                <MetricCard
                  title="Today's Intake"
                  value={metrics.todayCount}
                  subtext="Real-time Capture Hub"
                  icon="fa-bolt"
                  colorClass="bg-blue-50 text-blue-600"
                />
                <MetricCard
                  title="Daily Interactions"
                  value={metrics.callsToday}
                  subtext="Voice Engagement Vol."
                  icon="fa-phone-volume"
                  colorClass="bg-emerald-50 text-emerald-600"
                />
                <MetricCard
                  title="Engagement Time"
                  value={metrics.avgDuration > 0 ? `${Math.floor(metrics.avgDuration / 60)}m ${metrics.avgDuration % 60}s` : '0s'}
                  subtext="Mean Resolution Time"
                  icon="fa-stopwatch"
                  colorClass="bg-amber-50 text-amber-600"
                />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
                <div className="lg:col-span-8 flex flex-col gap-8">
                  <div className="flex flex-col md:flex-row gap-8 min-h-[420px]">
                    <div className="flex-1 flex h-full min-w-0"><VelocityMap data={metrics.dailyVolume} /></div>
                    <div className="h-full flex shrink-0"><FunnelAnatomy metrics={metrics} /></div>
                  </div>
                  <div className="min-h-[220px] h-full flex"><IntelligenceHeatmap data={metrics.activityHeatmap} /></div>
                </div>

                <div className="lg:col-span-4 h-full sticky top-8">
                  <div className="glass-card-premium p-8 rounded-[2.5rem] h-full flex flex-col border border-slate-100 min-h-[660px]">
                    <div className="flex items-center justify-between mb-8">
                      <div>
                        <h3 className="text-sm font-black text-slate-900 tracking-tight uppercase">Recent Intelligence</h3>
                        <p className="text-[10px] text-slate-400 font-bold uppercase mt-0.5">Live Stream</p>
                      </div>
                      <button
                        onClick={() => setActiveView('contacts')}
                        className="w-10 h-10 rounded-2xl bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-400 hover:text-indigo-600 hover:border-indigo-100 hover:bg-white transition-all group"
                      >
                        <i className="fa-solid fa-arrow-right text-xs group-hover:translate-x-0.5 transition-transform"></i>
                      </button>
                    </div>

                    <div className="space-y-4 flex-1 overflow-y-auto pr-2 -mr-2">
                      {leads.slice(0, 8).map((lead, idx) => (
                        <div
                          key={lead.id}
                          onClick={() => { setActiveLead(lead); setActiveView('dialer'); }}
                          className="p-5 bg-white rounded-3xl border border-slate-100 hover:border-indigo-100 hover:shadow-xl hover:shadow-indigo-500/5 transition-all cursor-pointer group relative overflow-hidden active:scale-[0.98]"
                        >
                          <div className="absolute top-0 right-0 w-24 h-24 bg-slate-50/50 rounded-full blur-2xl -mr-12 -mt-12 group-hover:bg-indigo-50/50 transition-colors"></div>
                          <div className="relative flex items-center justify-between">
                            <div className="flex items-center gap-4">
                              <div className="w-11 h-11 rounded-2xl bg-slate-50 flex items-center justify-center text-[10px] font-bold text-slate-400 border border-slate-50 group-hover:text-indigo-600 group-hover:border-indigo-100 group-hover:bg-white transition-all shadow-sm">
                                {getInitials(lead.first_name, lead.last_name)}
                              </div>
                              <div className="min-w-0">
                                <p className="text-[13px] font-black text-slate-900 group-hover:text-indigo-600 transition-colors uppercase tracking-tight truncate w-32">
                                  {lead.first_name} {lead.last_name}
                                </p>
                                <p className="text-[10px] text-slate-400 font-bold mt-0.5 flex items-center gap-1.5 uppercase tracking-widest">
                                  <i className="fa-regular fa-clock text-[9px]"></i>
                                  {getTimeAgo(lead.created_at)}
                                </p>
                              </div>
                            </div>
                            <div className="flex flex-col items-end gap-1.5">
                              <div className="px-2.5 py-1 bg-slate-50 rounded-lg border border-slate-100 group-hover:border-indigo-100 group-hover:bg-indigo-50/30 transition-all">
                                <span className="text-[9px] font-black text-slate-500 group-hover:text-indigo-600 uppercase tracking-tighter">
                                  {formatStatusForDisplay(lead.status)}
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
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
                {/* Modern Header */}
                <header className="h-20 border-b border-slate-100 flex items-center justify-between px-8 shrink-0">
                  <div className="flex items-center gap-5">
                    <div className="relative">
                      <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center text-white font-bold text-xl shadow-lg shadow-blue-200">
                        {getInitials(activeLead?.first_name || '', activeLead?.last_name || '')}
                      </div>
                      {/* <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-white rounded-full flex items-center justify-center shadow-sm">
                    <i className="fa-brands fa-facebook text-blue-600 text-[10px]"></i>
                  </div> */}
                    </div>
                    <div>
                      <h1 className="text-xl font-bold text-slate-900 tracking-tight">
                        {activeLead ? `${activeLead.first_name} ${activeLead.last_name}` : 'Select a Lead'}
                      </h1>
                      <div className="flex items-center gap-3 mt-0.5">
                        <span className="text-xs font-medium text-slate-500">
                          <i className="fa-solid fa-location-dot mr-1 opacity-70"></i>
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
                  </div>
                </header>

                <div className="flex-1 flex overflow-hidden">
                  {/* Details Column */}
                  <div className="w-[380px] p-8 overflow-y-auto border-r border-slate-50">
                    <section className="mb-8">
                      <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-[0.2em] mb-6">Primary Information</h3>
                      <div className="space-y-6">
                        <div className="group cursor-pointer">
                          <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1 transition-colors group-hover:text-blue-600">Mobile Phone</label>
                          <div className="flex items-center justify-between text-slate-900 font-semibold border-b border-slate-100 pb-2 group-hover:border-blue-200 transition-all">
                            <span>{activeLead?.phone || '--'}</span>
                            <i className="fa-solid fa-copy text-slate-300 text-[10px]"></i>
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
                          <i className="fa-solid fa-plus text-[9px]"></i> Tag
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
                                <i className="fa-solid fa-xmark text-[10px]"></i>
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

                  {/* Timeline Column */}
                  <div className="flex-1 bg-slate-50/50 p-8 overflow-y-auto relative">
                    <div className="max-w-2xl mx-auto">
                      <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-[0.2em] mb-8">Lead Activity Timeline</h3>

                      <div className="space-y-8 relative">
                        {leadActivities.length > 0 ? (
                          <>
                            <div className="absolute left-5 top-2 bottom-2 w-0.5 bg-slate-200"></div>
                            {leadActivities.map((activity) => {
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
                                    <div className="flex justify-between items-center mb-3">
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
                                      <span className="text-[10px] font-medium text-slate-400">{timeAgo}</span>
                                    </div>

                                    {/* Description */}
                                    <p className="text-sm text-slate-600 mb-2">{activity.description}</p>

                                    {/* Call details */}
                                    {activity.activity_type === 'call' && (
                                      <div className="bg-blue-50 rounded-lg p-3 border border-blue-100 mt-3 space-y-2">
                                        {metadata?.phone_number && (
                                          <div className="flex items-center gap-2">
                                            <i className="fa-solid fa-phone text-blue-600 text-xs"></i>
                                            <span className="text-xs font-semibold text-blue-700">
                                              {metadata.phone_number}
                                            </span>
                                            {metadata?.call_type && (
                                              <span className="text-xs text-blue-500">
                                                ({metadata.call_type === 'outbound' ? 'Outbound' : 'Inbound'})
                                              </span>
                                            )}
                                          </div>
                                        )}
                                        {metadata?.duration_seconds !== undefined && metadata.duration_seconds > 0 && (
                                          <div className="flex items-center gap-2">
                                            <i className="fa-solid fa-clock text-blue-600 text-xs"></i>
                                            <span className="text-xs font-semibold text-blue-700">
                                              Duration: {formatCallDuration(metadata.duration_seconds)}
                                            </span>
                                          </div>
                                        )}
                                      </div>
                                    )}

                                    {/* Status change details */}
                                    {activity.activity_type === 'disposition_change' && (
                                      <div className="bg-green-50 rounded-lg p-3 border border-green-100 mt-3">
                                        <div className="flex items-center gap-2 text-xs">
                                          <span className="text-slate-500">From:</span>
                                          <span className="px-2 py-0.5 rounded bg-white border border-green-200 text-green-700 font-semibold">
                                            {metadata?.old_status_display || metadata?.old_status || 'Unknown'}
                                          </span>
                                          <i className="fa-solid fa-arrow-right text-green-600 text-[10px]"></i>
                                          <span className="px-2 py-0.5 rounded bg-white border border-green-200 text-green-700 font-semibold">
                                            {metadata?.new_status_display || metadata?.new_status || 'Unknown'}
                                          </span>
                                        </div>
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

              {/* 3. RIGHT PANEL (THE ENGINE) */}
              <aside className="w-[400px] bg-white border-l border-slate-100 flex flex-col">
                {/* Dialer UI */}
                <div className="bg-[#1E293B] shadow-inner h-[400px] overflow-hidden relative flex flex-col">
                  {/* Video elements are now at root level for WebPhone initialization */}

                  {isDownloadingRecordings && (
                    <div className="absolute inset-0 bg-slate-900/90 z-20 flex flex-col items-center justify-center text-white p-6 text-center">
                      <i className="fa-solid fa-cloud-arrow-down text-3xl mb-4 text-blue-400 animate-bounce"></i>
                      <p className="text-sm font-bold mb-2">Downloading Recordings...</p>
                      <p className="text-xs text-slate-400 font-mono">{downloadProgress}</p>
                    </div>
                  )}

                  {/* WebPhone Dialer UI */}
                  <div className="flex-1 flex flex-col items-center justify-center p-6 text-white">
                    {/* Power Dialer Toggle */}
                    {/* <div className="absolute top-4 right-4">
                  <button
                    onClick={() => setPowerDialerEnabled(!powerDialerEnabled)}
                    disabled={!webPhoneReady}
                    className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-all shadow-lg ${
                      powerDialerEnabled
                        ? 'bg-amber-600 hover:bg-amber-700 text-white'
                        : 'bg-slate-700 hover:bg-slate-600 text-slate-200'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                    title={powerDialerEnabled ? 'Power Dialer: ON - Auto-dialing enabled' : 'Power Dialer: OFF - Manual dial only'}
                  >
                    <i className={`fa-solid ${powerDialerEnabled ? 'fa-bolt' : 'fa-bolt-slash'}`}></i>
                    Power Dialer
                  </button>
                </div> */}

                    <div className={`w-20 h-20 rounded-full border-2 flex items-center justify-center mb-4 transition-all ${webPhoneReady
                      ? powerDialerEnabled
                        ? 'bg-amber-600/20 border-amber-500/50'
                        : 'bg-green-600/20 border-green-500/50'
                      : currentCall
                        ? 'bg-blue-600/20 border-blue-500/50 animate-pulse'
                        : 'bg-blue-600/20 border-blue-500/50'
                      }`}>
                      <i className={`fa-solid text-3xl ${currentCall ? 'fa-phone text-blue-400' :
                        webPhoneReady
                          ? powerDialerEnabled
                            ? 'fa-bolt text-amber-400'
                            : 'fa-phone text-green-400'
                          : 'fa-phone text-blue-400'
                        }`}></i>
                    </div>

                    <h3 className="text-lg font-bold mb-2">Web Phone</h3>
                    <p className="text-xs text-slate-400 mb-2 uppercase tracking-widest text-center px-4">{webPhoneStatus}</p>
                    {powerDialerEnabled && webPhoneReady && (
                      <p className="text-xs text-amber-400 mb-4 font-bold uppercase tracking-widest">⚡ Power Dialer Active</p>
                    )}

                    {activeLead?.phone && (
                      <div className="text-center mb-4 w-full">
                        <p className="text-xs text-slate-400 mb-1">Current Lead</p>
                        <p className="text-lg font-bold">{activeLead.phone}</p>
                        <p className="text-xs text-slate-500 mt-1">{activeLead.first_name} {activeLead.last_name}</p>
                      </div>
                    )}

                    {currentCall ? (
                      <div className="flex gap-3 mt-4">
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
                          className="px-6 py-3 bg-red-600 hover:bg-red-700 rounded-xl text-sm font-bold flex items-center gap-2 transition-all shadow-lg"
                        >
                          <i className="fa-solid fa-phone-slash"></i> End Call
                        </button>
                      </div>
                    ) : webPhoneReady && activeLead?.phone && !powerDialerEnabled ? (
                      <button
                        onClick={() => handleDial()}
                        disabled={!webPhoneReady || !activeLead?.phone}
                        className="mt-4 px-8 py-3 bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-sm font-bold flex items-center gap-2 transition-all shadow-lg"
                      >
                        <i className="fa-solid fa-phone"></i> Call {activeLead.phone}
                      </button>
                    ) : !webPhoneReady ? (
                      <div className="mt-4 text-center">
                        <i className="fa-solid fa-circle-notch fa-spin text-blue-400 text-2xl"></i>
                        <p className="text-xs text-slate-400 mt-2">Initializing...</p>
                      </div>
                    ) : powerDialerEnabled && webPhoneReady ? (
                      <div className="mt-4 text-center">
                        <p className="text-xs text-amber-400 font-bold">Auto-dialing enabled</p>
                        <p className="text-xs text-slate-400 mt-1">Will dial when lead is selected</p>
                      </div>
                    ) : (
                      <div className="mt-4 text-center">
                        <p className="text-xs text-slate-400">Select a lead to call</p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Dispositions */}
                <div className="flex-1 overflow-y-auto p-6 bg-slate-50/30">
                  <div className="mb-6">
                    <h4 className="text-sm font-bold text-slate-900 mb-1">Select Outcome <span className="text-red-500">*</span></h4>
                    <p className="text-[11px] text-slate-500">You must disposition this lead to move to the next item in queue.</p>
                  </div>

                  <div className="grid grid-cols-2 gap-2 mb-8">
                    {DISPOSITION_OPTIONS.map((option) => {
                      const isActive = selectedDisposition === option;
                      return (
                        <button
                          key={option}
                          onClick={async () => {
                            setSelectedDisposition(option);
                            if (isPowerDialing && currentCall && activeLead) {
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

                  {/* Qualification Form */}
                  <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
                    <div className="flex items-center gap-2 mb-5 border-b border-slate-50 pb-4">
                      <div className="w-7 h-7 bg-green-50 rounded-lg flex items-center justify-center text-green-600">
                        <i className="fa-solid fa-check-to-slot text-xs"></i>
                      </div>
                      <h5 className="font-bold text-sm">Qualification Details</h5>
                    </div>

                    <div className="space-y-4">
                      <div>
                        <label className="block text-[10px] font-bold text-slate-400 uppercase mb-2">Estimated Debt</label>
                        <select className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-sm focus:ring-2 focus:ring-blue-100 outline-none appearance-none cursor-pointer">
                          <option>$10,000 - $25,000</option>
                          <option>$25,000 - $50,000</option>
                          <option>$50,000+</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-[10px] font-bold text-slate-400 uppercase mb-2">Unfiled Years</label>
                        <input type="text" className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-blue-100" defaultValue="2018, 2019, 2021" />
                      </div>

                      <div>
                        <label className="block text-[10px] font-bold text-slate-400 uppercase mb-2">Monthly Income</label>
                        <div className="relative">
                          <span className="absolute left-4 top-3.5 text-slate-400 text-sm font-bold">$</span>
                          <input type="number" className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 pl-8 text-sm outline-none focus:ring-2 focus:ring-blue-100" defaultValue="4500" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Final Submission - Show for Qualified leads (even during power dialing) */}
                {activeLead && (activeLead.status === 'Qualified' || activeLead.status === 'Qualified Lead') && (
                  <div className="p-6 border-t border-slate-100 bg-white">
                    <button
                      onClick={() => handleSubmitDisposition(undefined, true)}
                      disabled={isSubmittingDisposition || !activeLead}
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
                    {/* <div className="flex justify-center mt-3">
                    <button
                      onClick={handleDownloadAllRecordings}
                      disabled={isDownloadingRecordings}
                      className="text-[10px] text-blue-500 hover:text-blue-700 underline flex items-center gap-1"
                    >
                      {isDownloadingRecordings ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-download"></i>}
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
                <header className="bg-white border-b border-slate-200 px-8 h-20 flex items-center justify-between shrink-0">
                  <div className="flex items-center gap-4">
                    <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Contacts</h1>
                    {/* <div className="h-6 w-px bg-slate-200"></div>
                <div className="flex bg-slate-100 p-1 rounded-xl">
                  <button className="px-4 py-1.5 text-xs font-bold bg-white shadow-sm rounded-lg text-blue-600">Smart Lists</button>
                  <button className="px-4 py-1.5 text-xs font-bold text-slate-500 hover:text-slate-900 transition-colors">Segments</button>
                </div> */}
                  </div>

                  <div className="flex items-center gap-3">
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
                      className="bg-white border border-red-200 text-red-600 px-5 py-2.5 rounded-xl font-bold text-sm shadow-sm hover:bg-red-50 transition-all flex items-center gap-2"
                    >
                      <i className="fa-solid fa-trash-can text-[10px]"></i>
                      Delete Leads
                    </button>
                    <button
                      onClick={() => setShowImportModal(true)}
                      disabled={isImporting}
                      className="bg-white border border-slate-200 text-slate-600 px-5 py-2.5 rounded-xl font-bold text-sm shadow-sm hover:bg-slate-50 transition-all flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      <i className="fa-solid fa-cloud-arrow-up text-[10px]"></i>
                      Import CSV
                    </button>

                    <button
                      onClick={() => setShowLeadModal(true)}
                      className="bg-blue-600 text-white px-5 py-2.5 rounded-xl font-bold text-sm shadow-lg shadow-blue-100 hover:bg-blue-700 transition-all flex items-center gap-2"
                    >
                      <i className="fa-solid fa-plus text-[10px]"></i> Add New Lead
                    </button>
                  </div>
                </header>

                {/* Sub-Header / Filters */}
                <div className="bg-white px-8 py-3 border-b border-slate-100 flex items-center justify-between shadow-sm">
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
                      <div className="flex flex-wrap gap-2">
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
                <div className="flex-1 overflow-auto bg-white p-8">
                  <table className="w-full text-left border-collapse min-w-[1000px]">
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

                {/* Pagination / Status Footer */}
                <footer className="h-14 px-8 border-t border-slate-200 bg-white flex items-center justify-between shrink-0">
                  <div className="flex items-center gap-4">
                    <div className="text-xs font-semibold text-slate-500">
                      Showing <span className="text-slate-900">{totalLeads > 0 ? (currentPage - 1) * itemsPerPage + 1 : 0} - {Math.min(currentPage * itemsPerPage, totalLeads)}</span> of {totalLeads} Leads
                    </div>
                    <div className="h-4 w-px bg-slate-200"></div>
                    <div className="flex items-center gap-2">
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

                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                      className="h-8 w-8 rounded-lg hover:bg-slate-100 transition-all text-slate-400 flex items-center justify-center border border-slate-100 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <i className="fa-solid fa-chevron-left text-[10px]"></i>
                    </button>

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
                            alert('No leads found for selected IDs');
                          }
                        } catch (err) {
                          console.error('Error starting power dial for selected:', err);
                          alert('Failed to start power dial');
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
                        if (confirm(`Are you sure you want to delete ${selectedLeads.size} leads?`)) {
                          setLoading(true);
                          try {
                            const { error } = await supabase.from('leads').delete().in('id', Array.from(selectedLeads));
                            if (error) throw error;
                            setSelectedLeads(new Set());
                            await fetchLeads();
                          } catch (err) {
                            console.error('Error deleting leads:', err);
                            alert('Failed to delete leads');
                          } finally {
                            setLoading(false);
                          }
                        }
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
      </div >

      {showImportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 px-4 backdrop-blur-sm">
          <div className="glass-modal rounded-3xl w-full max-w-2xl p-8 relative animate-float">
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
                      <i className="fa-solid fa-cloud-arrow-up text-[11px]"></i>
                      Import CSV
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {
        showDeleteModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 px-4 backdrop-blur-sm">
            <div className="glass-modal rounded-3xl w-full max-w-lg p-8 relative animate-float">
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
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 px-4 backdrop-blur-sm">
            <div className="glass-modal rounded-3xl w-full max-w-3xl p-8 relative animate-float">
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

