/**
 * RingSense Insights - Get call logs, retrieve insights, and save to database
 * 
 * Run with: npx tsx scripts/ringsense-fetch-and-save.ts
 * 
 * Requires:
 * - npm install @ringcentral/sdk @supabase/supabase-js
 * - Environment variables:
 *   - RINGCENTRAL_SERVER
 *   - RINGCENTRAL_CLIENT_ID
 *   - RINGCENTRAL_CLIENT_SECRET
 *   - RINGCENTRAL_JWT
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY (for admin access)
 */

import { SDK } from '@ringcentral/sdk';
import { createClient } from '@supabase/supabase-js';

// RingCentral credentials from environment variables
const server = process.env.RINGCENTRAL_SERVER || 'https://platform.ringcentral.com';
const clientId = process.env.RINGCENTRAL_CLIENT_ID || '';
const clientSecret = process.env.RINGCENTRAL_CLIENT_SECRET || '';
const jwt = process.env.RINGCENTRAL_JWT || '';

// Supabase credentials
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!clientId || !clientSecret || !jwt) {
  console.error('Error: RingCentral credentials not set. Please set RINGCENTRAL_CLIENT_ID, RINGCENTRAL_CLIENT_SECRET, and RINGCENTRAL_JWT environment variables.');
  process.exit(1);
}

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Error: Supabase credentials not set. Please set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.');
  process.exit(1);
}

// Initialize Supabase client with service role key for admin access
const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

/**
 * Get call logs with detailed view
 * Returns records with telephonySessionId and recording.id
 */
async function getCallLogs(platform: any, perPage: number = 10) {
  try {
    console.log('--- Fetching Call Logs ---');
    const path = `/restapi/v1.0/account/~/call-log?view=Detailed&perPage=${perPage}`;
    const resp = await platform.get(path);
    const data = await resp.json();
    
    console.log(`Found ${data.records?.length || 0} call records`);
    return data.records || [];
  } catch (e: any) {
    console.error('Failed to get call logs:', e.message || e);
    if (e.response) {
      try {
        const text = await e.response.text();
        console.error('Error body:', text);
      } catch (_) {}
    }
    throw e;
  }
}

/**
 * Get RingSense insights by recording ID
 * Use this for single recordings
 */
async function getRingSenseInsightsByRecordId(platform: any, recordId: string) {
  try {
    console.log(`--- Fetching RingSense Insights by Record ID: ${recordId} ---`);
    const path = `/ai/ringsense/v1/public/accounts/~/domains/pbx/records/${recordId}/insights`;
    const resp = await platform.get(path);
    const data = await resp.json();
    return data;
  } catch (e: any) {
    console.error(`Failed to get insights for record ${recordId}:`, e.message || e);
    if (e.response) {
      try {
        const text = await e.response.text();
        console.error('Error body:', text);
      } catch (_) {}
    }
    throw e;
  }
}

/**
 * Get RingSense insights by session ID
 * Use this if the call had transfers (multiple recordings per session)
 */
async function getRingSenseInsightsBySessionId(platform: any, sessionId: string) {
  try {
    console.log(`--- Fetching RingSense Insights by Session ID: ${sessionId} ---`);
    const path = `/ai/ringsense/v1/public/accounts/~/domains/pbx/sessions/${sessionId}/insights`;
    const resp = await platform.get(path);
    const data = await resp.json();
    return data;
  } catch (e: any) {
    console.error(`Failed to get insights for session ${sessionId}:`, e.message || e);
    if (e.response) {
      try {
        const text = await e.response.text();
        console.error('Error body:', text);
      } catch (_) {}
    }
    throw e;
  }
}

/**
 * Display transcript from insights
 */
function displayTranscript(insights: any) {
  if (!insights?.insights?.Transcript) {
    console.log('No transcript found in insights');
    return;
  }

  const transcript = insights.insights.Transcript;
  console.log('\n--- Transcript ---');
  console.log(`Total segments: ${transcript.length}\n`);

  transcript.forEach((t: any, index: number) => {
    const startTime = formatTime(t.start);
    const endTime = formatTime(t.end);
    console.log(`[${startTime} - ${endTime}] Speaker ${t.speakerId}: ${t.text}`);
  });

  // Display speaker info if available
  if (insights.insights.speakerInfo) {
    console.log('\n--- Speaker Information ---');
    Object.entries(insights.insights.speakerInfo).forEach(([speakerId, info]: [string, any]) => {
      console.log(`Speaker ${speakerId}: ${info.name || 'Unknown'}`);
    });
  }
}

/**
 * Format time in seconds to MM:SS format
 */
function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Save call recording and insights to database
 */
async function saveCallRecordingToDB(callRecord: any, insights: any, userId?: string) {
  try {
    const transcription = insights?.insights?.Transcript || null;
    const summary = insights?.insights?.Summary || insights?.insights?.summary || null;
    const speakerInfo = insights?.insights?.speakerInfo || null;

    // Extract summary text if it's an object
    let summaryText = null;
    if (summary) {
      if (typeof summary === 'string') {
        summaryText = summary;
      } else if (summary.text) {
        summaryText = summary.text;
      } else if (summary.content) {
        summaryText = summary.content;
      }
    }

    const recordingData: any = {
      call_id: callRecord.id,
      session_id: callRecord.telephonySessionId || null,
      record_id: callRecord.recording?.id,
      direction: callRecord.direction || null,
      from_number: callRecord.from?.phoneNumber || null,
      from_name: callRecord.from?.name || null,
      to_number: callRecord.to?.phoneNumber || null,
      to_name: callRecord.to?.name || null,
      start_time: callRecord.startTime || null,
      duration: callRecord.duration || null,
      transcription: transcription,
      summary: summaryText,
      speaker_info: speakerInfo,
      insights: insights,
    };

    // If userId is provided, add it
    if (userId) {
      recordingData.user_id = userId;
    }

    // Use upsert to handle duplicates (based on record_id unique constraint)
    const { data, error } = await supabase
      .from('call_recordings')
      .upsert(recordingData, {
        onConflict: 'record_id',
        ignoreDuplicates: false,
      })
      .select()
      .single();

    if (error) {
      console.error('Error saving call recording:', error);
      throw error;
    }

    console.log(`✓ Saved call recording to database: ${data.id}`);
    return data;
  } catch (error: any) {
    console.error('Failed to save call recording to DB:', error);
    throw error;
  }
}

/**
 * Main function
 */
async function main() {
  const rcsdk = new SDK({ server, clientId, clientSecret });
  const platform = rcsdk.platform();

  try {
    // Login with JWT
    console.log('--- Authenticating ---');
    await platform.login({ jwt });
    console.log('Authentication successful\n');

    // Get call logs
    const perPage = parseInt(process.env.PER_PAGE || '10');
    const limit = process.env.LIMIT ? parseInt(process.env.LIMIT) : null;
    
    const records = await getCallLogs(platform, perPage);
    
    if (records.length === 0) {
      console.log('No call records found');
      return;
    }

    // Find calls with recordings
    const callsWithRecordings = records.filter(
      (call: any) => call.recording && call.recording.id
    );

    if (callsWithRecordings.length === 0) {
      console.log('No calls with recordings found');
      console.log('\n--- Sample Call Record (no recording) ---');
      console.log(JSON.stringify(records[0], null, 2));
      return;
    }

    // Limit the number of calls to process if specified
    const callsToProcess = limit 
      ? callsWithRecordings.slice(0, limit)
      : callsWithRecordings;

    console.log(`\nFound ${callsToProcess.length} calls with recordings\n`);

    const results = {
      processed: 0,
      saved: 0,
      failed: 0,
      errors: [] as Array<{ callId: string; error: string }>,
    };

    // Process each call
    for (const call of callsToProcess) {
      try {
        const sourceSessionId = call.telephonySessionId;
        const sourceRecordId = call.recording.id;

        console.log('--- Call Information ---');
        console.log('Call ID:', call.id);
        console.log('Direction:', call.direction);
        console.log('From:', call.from?.phoneNumber || call.from?.name);
        console.log('To:', call.to?.phoneNumber || call.to?.name);
        console.log('Start Time:', call.startTime);
        console.log('Duration:', call.duration, 'seconds');
        console.log('Source Session ID:', sourceSessionId);
        console.log('Source Record ID:', sourceRecordId);
        console.log('');

        let insights = null;

        // Try to get insights by record ID first
        try {
          insights = await getRingSenseInsightsByRecordId(platform, sourceRecordId);
          console.log('\n--- RingSense Insights (by Record ID) ---');
          console.log(JSON.stringify(insights, null, 2));
          
          // Display transcript if available
          displayTranscript(insights);
        } catch (recordError: any) {
          console.log(`\nFailed to get insights by record ID: ${recordError.message}`);
          console.log('Trying session ID instead...\n');
          
          // Fallback to session ID
          if (sourceSessionId) {
            try {
              insights = await getRingSenseInsightsBySessionId(platform, sourceSessionId);
              console.log('\n--- RingSense Insights (by Session ID) ---');
              console.log(JSON.stringify(insights, null, 2));
              
              // Display transcript if available
              displayTranscript(insights);
            } catch (sessionError: any) {
              console.error(`Failed to get insights by session ID: ${sessionError.message}`);
              results.failed++;
              results.errors.push({
                callId: call.id,
                error: sessionError.message,
              });
              continue;
            }
          } else {
            results.failed++;
            results.errors.push({
              callId: call.id,
              error: recordError.message,
            });
            continue;
          }
        }

        // Save to database
        await saveCallRecordingToDB(call, insights);
        results.saved++;
        results.processed++;

        console.log('\n--- Saved to Database ---\n');
      } catch (error: any) {
        console.error(`Failed to process call ${call.id}:`, error);
        results.failed++;
        results.errors.push({
          callId: call.id,
          error: error.message || 'Unknown error',
        });
      }
    }

    // Summary
    console.log('\n--- Summary ---');
    console.log(`Processed: ${results.processed}`);
    console.log(`Saved: ${results.saved}`);
    console.log(`Failed: ${results.failed}`);
    if (results.errors.length > 0) {
      console.log('\nErrors:');
      results.errors.forEach((err) => {
        console.log(`  - Call ${err.callId}: ${err.error}`);
      });
    }

    // List all calls with recordings for reference
    console.log('\n--- All Calls with Recordings ---');
    callsWithRecordings.forEach((call: any, index: number) => {
      console.log(`\n[${index + 1}] Call ID: ${call.id}`);
      console.log(`    Session ID: ${call.telephonySessionId}`);
      console.log(`    Record ID: ${call.recording?.id}`);
      console.log(`    Direction: ${call.direction}`);
      console.log(`    From: ${call.from?.phoneNumber || call.from?.name}`);
      console.log(`    To: ${call.to?.phoneNumber || call.to?.name}`);
      console.log(`    Start: ${call.startTime}`);
    });

  } catch (err: any) {
    console.error('Error:', err.message || err);
    if (err.response) {
      try {
        const text = await err.response.text();
        console.error('Error body:', text);
      } catch (_) {}
    }
    process.exit(1);
  }
}

// Run main function
main().catch((err: any) => {
  console.error('Fatal error:', err.message || err);
  process.exit(1);
});

