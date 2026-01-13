'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '@/utils/supabase/client';
import Papa from 'papaparse';
import WebPhone from '@/lib/ringcentral-webphone';
import { SDK } from '@ringcentral/sdk';

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

export default function DashboardPage() {
  const [activeView, setActiveView] = useState<'dialer' | 'contacts'>('dialer');
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
  const [selectedDisposition, setSelectedDisposition] = useState<string>('No Answer');
  const [itemsPerPage, setItemsPerPage] = useState(50);
  const [isSubmittingDisposition, setIsSubmittingDisposition] = useState(false);
  const [webPhone, setWebPhone] = useState<WebPhone | null>(null);
  const [webPhoneReady, setWebPhoneReady] = useState(false);
  const [webPhoneStatus, setWebPhoneStatus] = useState('Initializing...');
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const [currentCall, setCurrentCall] = useState<any>(null);
  // const itemsPerPage = 50; // Replaced with state

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

  useEffect(() => {
    if (activeView === 'contacts') {
      fetchLeads();
    }
  }, [activeView, currentPage, sortConfig, viewMode, statusFilter, dateFilterMode, selectedDate, selectedMonth, itemsPerPage]);

  useEffect(() => {
    const displayStatus = getDisplayStatusFromDb(activeLead?.status);
    if (DISPOSITION_OPTIONS.includes(displayStatus as typeof DISPOSITION_OPTIONS[number])) {
      setSelectedDisposition(displayStatus);
    } else {
      setSelectedDisposition('No Answer');
    }
    setShowTagInput(false);
    setNewTagValue('');
  }, [activeLead]);

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

        const phone = new WebPhone(sipData, {
          clientId,
          appName: 'LeadsDashboard',
          appVersion: '1.0.0',
          logLevel: 1, // Reduced logging for production
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
          setWebPhoneStatus('Incoming call...');
          setCurrentCall(session);
          
          session.accept().then(() => {
            console.log('Call accepted');
            setWebPhoneStatus('Call connected');
          });
          
          session.on('terminated', () => {
            setWebPhoneStatus('Call ended');
            setCurrentCall(null);
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
  const handleDial = useCallback(async () => {
    if (!webPhone || !webPhoneReady || !activeLead?.phone) {
      alert('WebPhone is not ready or no phone number available');
      return;
    }

    if (currentCall) {
      alert('A call is already in progress');
      return;
    }

    try {
      setWebPhoneStatus(`Dialing ${activeLead.phone}...`);
      
      // Clean phone number (remove any formatting)
      const cleanNumber = activeLead.phone.replace(/\D/g, '');
      
      const session = webPhone.userAgent.invite(cleanNumber, {
        fromNumber: cleanNumber, // You may need to set your verified number here
      });
      
      setCurrentCall(session);
      
      session.on('accepted', () => {
        console.log('Call accepted');
        setWebPhoneStatus('Call connected');
      });
      
      session.on('progress', () => {
        setWebPhoneStatus('Ringing...');
      });
      
      session.on('terminated', () => {
        console.log('Call terminated');
        setWebPhoneStatus('Call ended');
        setCurrentCall(null);
      });
      
      session.on('rejected', () => {
        console.log('Call rejected');
        setWebPhoneStatus('Call rejected');
        setCurrentCall(null);
      });
      
      session.on('failed', () => {
        console.log('Call failed');
        setWebPhoneStatus('Call failed');
        setCurrentCall(null);
      });
      
    } catch (error: any) {
      console.error('Failed to dial:', error);
      setWebPhoneStatus(`Dial failed: ${error.message || 'Unknown error'}`);
      setCurrentCall(null);
    }
  }, [webPhone, webPhoneReady, activeLead?.phone, currentCall]);

  // Auto-dial when active lead changes (only if WebPhone is ready)
  useEffect(() => {
    // Only auto-dial if WebPhone is fully ready and no call is in progress
    if (webPhone && webPhoneReady && activeLead?.phone && !currentCall) {
      // Add a delay to ensure WebPhone is fully registered and ready
      const timer = setTimeout(() => {
        // Double-check conditions before dialing
        if (webPhone && webPhoneReady && activeLead?.phone && !currentCall) {
          handleDial();
        }
      }, 2000); // Wait 2 seconds after lead changes to ensure everything is ready
      
      return () => clearTimeout(timer);
    }
  }, [activeLead?.id, webPhone, webPhoneReady, currentCall, handleDial]); // Trigger when lead ID changes

  const fetchLeads = async () => {
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
  };

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

  const handleSubmitDisposition = async () => {
    if (!activeLead) return;
    setIsSubmittingDisposition(true);
    try {
      const statusToSave = getPrimaryStatusValue(selectedDisposition);
      const { error } = await supabase
        .from('leads')
        .update({ status: statusToSave })
        .eq('id', activeLead.id);
      if (error) throw error;

      if (activeLead) {
        updateLeadInState({ ...activeLead, status: statusToSave });
      }
      await fetchLeads();
      alert('Disposition saved successfully!');
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
      <div className="bg-slate-50 text-slate-900 h-screen overflow-hidden flex" style={{ fontFamily: "var(--font-geist-sans), 'Inter', sans-serif" }}>
        <style>{`
          :root {
            --p-indigo: #6366f1;
          }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #e2e8f0; border-radius: 10px; }
        ::-webkit-scrollbar-thumb:hover { background: #cbd5e1; }
        .active-ring { box-shadow: 0 0 0 2px #3b82f6, 0 0 0 4px rgba(59, 130, 246, 0.2); }
        .checkbox-custom:checked { background-color: #3b82f6; border-color: #3b82f6; }
        
        /* Glass Modal Styles */
        .glass-modal {
          background: rgba(255, 255, 255, 0.95);
          backdrop-filter: blur(20px) saturate(180%);
          border: 1px solid rgba(255, 255, 255, 0.5);
          box-shadow: 0 20px 50px -10px rgba(0,0,0,0.15);
        }
        .glass-input {
          background: rgba(241, 245, 249, 0.5); /* slate-100 with opacity */
          border: 1px solid rgba(0, 0, 0, 0.05);
          transition: all 0.3s ease;
        }
        .glass-input:focus {
          background: #ffffff;
          border-color: var(--p-indigo);
          box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.1);
          outline: none;
        }
        .glass-label {
          font-size: 10px;
          font-weight: 900;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          color: #94a3b8; /* slate-400 */
          margin-bottom: 6px;
          display: block;
        }
      `}</style>

      {/* 1. LEFT NAVIGATION (SLIMMER & MORE MODERN) */}
      <aside className="w-64 bg-slate-950 text-white flex flex-col shrink-0 border-r border-white/10">
        <div className="h-16 flex items-center px-6 mb-4">
          <span className="font-bold tracking-tight text-lg">Integrated <span className="text-blue-400">Financial</span></span>
        </div>

        <nav className="px-4 space-y-1">
          <button 
            onClick={() => setActiveView('dialer')}
            className={`w-full flex items-center space-x-3 px-3 py-2 rounded-xl transition-all ${
              activeView === 'dialer' 
                ? 'bg-blue-600/10 text-blue-400 border border-blue-600/20' 
                : 'text-slate-400 hover:bg-white/5 hover:text-white'
            }`}
          >
            <i className="fa-solid fa-headset w-5"></i> <span className="font-medium text-sm">Power Dialer</span>
          </button>
          
          <button 
            onClick={() => setActiveView('contacts')}
            className={`w-full flex items-center space-x-3 px-3 py-2 rounded-xl transition-all ${
              activeView === 'contacts' 
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
        {activeView === 'dialer' && (
          <div className="mt-8 px-4 flex-1">
            <div className="flex items-center justify-between px-3 mb-4">
              <span className="text-[10px] uppercase font-bold tracking-widest text-slate-500">Live Queue</span>
              <span className="text-[10px] bg-slate-800 px-2 py-0.5 rounded text-slate-400 font-mono">12 REMAINING</span>
            </div>

            <div className="space-y-2">
            {/* Active Item */}
            {activeLead && (
              <div className="bg-slate-900/50 p-3 rounded-xl border border-blue-500/30 ring-1 ring-blue-500/20 shadow-xl">
                <div className="flex justify-between items-start mb-1">
                  <span className="font-semibold text-sm text-white">
                    {activeLead.first_name} {activeLead.last_name}
                  </span>
                  <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse mt-1"></span>
                </div>
                <div className="text-[11px] text-blue-400 flex items-center gap-1">
                  <i className="fa-solid fa-phone-flip text-[9px]"></i> Active Session
                </div>
              </div>
            )}

            {/* Up Next */}
            {leads.length > 1 && (
              <div className="p-3 rounded-xl border border-white/5 bg-white/5 opacity-40 grayscale">
                <span className="font-medium text-sm block mb-1">
                  {leads.find(l => l.id !== activeLead?.id)?.first_name} {leads.find(l => l.id !== activeLead?.id)?.last_name}
                </span>
                <span className="text-[10px] uppercase tracking-tighter">Waiting for disposition</span>
              </div>
            )}
            </div>
          </div>
        )}
      </aside>

      {/* VIEW: DIALER */}
      {activeView === 'dialer' && (
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
                  <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-white rounded-full flex items-center justify-center shadow-sm">
                    <i className="fa-brands fa-facebook text-blue-600 text-[10px]"></i>
                  </div>
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

              <div className="flex items-center gap-2">
                <button className="h-10 px-4 rounded-xl border border-slate-200 hover:bg-slate-50 text-sm font-semibold transition-all flex items-center gap-2 shadow-sm">
                  <i className="fa-regular fa-calendar text-blue-600"></i> Schedule
                </button>
                <button className="h-10 w-10 rounded-xl border border-slate-200 hover:bg-slate-50 transition-all flex items-center justify-center shadow-sm">
                  <i className="fa-regular fa-envelope text-slate-600"></i>
                </button>
                <button className="h-10 w-10 rounded-xl border border-slate-200 hover:bg-slate-50 transition-all flex items-center justify-center shadow-sm text-blue-600">
                  <i className="fa-solid fa-comment-sms"></i>
                </button>
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
                    <div className="absolute left-5 top-2 bottom-2 w-0.5 bg-slate-200"></div>

                    {/* Timeline Item: Call */}
                    <div className="relative pl-12">
                      <div className="absolute left-0 top-0 w-10 h-10 rounded-2xl bg-white border border-slate-200 shadow-sm flex items-center justify-center z-10">
                        <i className="fa-solid fa-phone text-blue-600"></i>
                      </div>
                      <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                        <div className="flex justify-between items-center mb-3">
                          <span className="text-sm font-bold text-slate-900">Inbound Call Ended</span>
                          <span className="text-[10px] font-medium text-slate-400">2 MINS AGO</span>
                        </div>
                        <div className="bg-slate-50 rounded-xl p-4 border border-slate-100">
                          <div className="flex items-center gap-2 mb-2">
                            <div className="w-4 h-4 rounded bg-purple-100 flex items-center justify-center">
                              <i className="fa-solid fa-robot text-purple-600 text-[8px]"></i>
                            </div>
                            <span className="text-[10px] font-bold text-purple-600 uppercase tracking-tight">AI Generated Summary</span>
                          </div>
                          <p className="text-sm text-slate-600 leading-relaxed italic">
                            &quot;Robert expressed urgent concern about a potential bank levy. Confirmed unfiled returns for 2018, 2019, and 2021. Household income is approx. $4,500/mo.&quot;
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* Timeline Item: Automation */}
                    <div className="relative pl-12">
                      <div className="absolute left-0 top-0 w-10 h-10 rounded-2xl bg-white border border-slate-200 shadow-sm flex items-center justify-center z-10">
                        <i className="fa-solid fa-bolt text-amber-500"></i>
                      </div>
                      <div className="bg-white/60 p-4 rounded-2xl border border-dashed border-slate-200">
                        <div className="flex justify-between items-center">
                          <span className="text-sm font-medium text-slate-600">Workflow: <strong>New Lead SMS Sent</strong></span>
                          <span className="text-[10px] font-medium text-slate-400">1 HOUR AGO</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </main>

          {/* 3. RIGHT PANEL (THE ENGINE) */}
          <aside className="w-[400px] bg-white border-l border-slate-200 shadow-2xl z-30 flex flex-col">
            {/* Dialer UI */}
            <div className="bg-slate-900 shadow-inner h-[400px] overflow-hidden relative flex flex-col">
              {/* Hidden video elements for WebRTC */}
              <video ref={remoteVideoRef} hidden />
              <video ref={localVideoRef} hidden muted />
              
              {isDownloadingRecordings && (
                <div className="absolute inset-0 bg-slate-900/90 z-20 flex flex-col items-center justify-center text-white p-6 text-center">
                  <i className="fa-solid fa-cloud-arrow-down text-3xl mb-4 text-blue-400 animate-bounce"></i>
                  <p className="text-sm font-bold mb-2">Downloading Recordings...</p>
                  <p className="text-xs text-slate-400 font-mono">{downloadProgress}</p>
                </div>
              )}
              
              {/* WebPhone Dialer UI */}
              <div className="flex-1 flex flex-col items-center justify-center p-6 text-white">
                <div className={`w-20 h-20 rounded-full border-2 flex items-center justify-center mb-4 transition-all ${
                  webPhoneReady 
                    ? 'bg-green-600/20 border-green-500/50' 
                    : currentCall
                    ? 'bg-blue-600/20 border-blue-500/50 animate-pulse'
                    : 'bg-blue-600/20 border-blue-500/50'
                }`}>
                  <i className={`fa-solid text-3xl ${
                    currentCall ? 'fa-phone text-blue-400' : 
                    webPhoneReady ? 'fa-phone text-green-400' : 
                    'fa-phone text-blue-400'
                  }`}></i>
                </div>
                
                <h3 className="text-lg font-bold mb-2">Web Phone</h3>
                <p className="text-xs text-slate-400 mb-4 uppercase tracking-widest text-center px-4">{webPhoneStatus}</p>
                
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
                      onClick={() => {
                        if (currentCall) {
                          currentCall.hangup();
                          setCurrentCall(null);
                        }
                      }}
                      className="px-6 py-3 bg-red-600 hover:bg-red-700 rounded-xl text-sm font-bold flex items-center gap-2 transition-all shadow-lg"
                    >
                      <i className="fa-solid fa-phone-slash"></i> End Call
                    </button>
                  </div>
                ) : webPhoneReady && activeLead?.phone ? (
                  <button
                    onClick={handleDial}
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

              <div className="grid grid-cols-2 gap-3 mb-8">
                {DISPOSITION_OPTIONS.map((option) => {
                  const isActive = selectedDisposition === option;
                  return (
                    <button
                      key={option}
                      onClick={() => setSelectedDisposition(option)}
                      className={`p-3 rounded-xl text-xs font-bold transition-all shadow-sm border ${
                        isActive
                          ? 'bg-blue-600 text-white border-blue-700 shadow-blue-200'
                          : 'bg-white text-slate-600 border-slate-200 hover:border-blue-400 hover:text-blue-600'
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

            {/* Final Submission */}
            <div className="p-6 border-t border-slate-100 bg-white">
              <button
                onClick={handleSubmitDisposition}
                disabled={isSubmittingDisposition || !activeLead}
                className="w-full bg-slate-900 text-white py-4 rounded-2xl font-bold text-sm shadow-xl hover:bg-slate-800 transition-all flex items-center justify-center gap-3 group disabled:opacity-60 disabled:cursor-not-allowed"
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
              <div className="flex justify-center mt-3">
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
              </p>
            </div>
          </aside>
        </>
      )}

      {/* VIEW: CONTACTS */}
      {activeView === 'contacts' && (
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
                          className={`px-3 py-1 rounded-xl text-xs font-bold border transition-all ${
                            isActive
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
                            className={`px-3 py-1 rounded-xl text-xs font-bold border transition-all ${
                              dateFilterMode === item.mode
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
                  <tr className="border-b border-slate-100 text-[11px] font-bold text-slate-400 uppercase tracking-widest">
                    <th className="py-4 px-2 w-10">
                      <input 
                        type="checkbox" 
                        className="rounded text-blue-600 border-slate-300 checkbox-custom" 
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
                    <th className="py-4 px-4 hover:text-blue-600 cursor-pointer group">
                      Lead Name {getSortIcon('name')}
                    </th>
                    <th className="py-4 px-4 hover:text-blue-600 cursor-pointer group">
                      Address
                    </th>
                    <th className="py-4 px-4 hover:text-blue-600 cursor-pointer group">
                      Contact Info {getSortIcon('contact')}
                    </th>
                    <th 
                      className="py-4 px-4 hover:text-blue-600 cursor-pointer group"
                      onClick={() => handleSort('status')}
                    >
                      Stage {getSortIcon('status')}
                    </th>
                    <th 
                      className="py-4 px-4 hover:text-blue-600 cursor-pointer group"
                      onClick={() => handleSort('created_at')}
                    >
                      Activity {getSortIcon('created_at')}
                    </th>
                    <th className="py-4 px-4">Tags</th>
                    <th className="py-4 px-4 text-right">Action</th>
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
                        className="group hover:bg-slate-50 transition-all border-b border-slate-50 cursor-pointer"
                        onClick={() => handleLeadClick(lead)}
                      >
                        <td className="py-4 px-2" onClick={(e) => e.stopPropagation()}>
                          <input 
                            type="checkbox" 
                            className="rounded text-blue-600 border-slate-300 checkbox-custom"
                            checked={selectedLeads.has(lead.id)}
                            onChange={() => toggleLeadSelection(lead.id)}
                          />
                        </td>
                        <td className="py-4 px-4">
                          <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-xl bg-blue-100 text-blue-600 font-bold flex items-center justify-center text-xs">
                              {getInitials(lead.first_name, lead.last_name)}
                            </div>
                            <div>
                              <div className="font-bold text-slate-900 group-hover:text-blue-600 transition-colors">
                                {lead.first_name} {lead.last_name}
                              </div>
                              <div className="text-[11px] text-slate-500 font-medium">
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
                          <button className="text-slate-400 hover:text-blue-600 p-2 transition-all">
                            <i className="fa-solid fa-phone"></i>
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
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
                    className={`h-8 w-8 rounded-lg transition-all text-[11px] font-bold ${
                      currentPage === pageNum 
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
                {/* <button className="text-xs font-bold hover:text-blue-400 transition-colors flex items-center gap-2"><i className="fa-solid fa-phone text-[11px]"></i> Update Call</button> */}
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
      )}
      </div>

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

      {showDeleteModal && (
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
      )}

      {showLeadModal && (
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
      )}
    </>
  );
}

