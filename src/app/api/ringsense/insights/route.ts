import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { SDK } from '@ringcentral/sdk';

// RingCentral credentials - hardcoded
const RC_SERVER = 'https://platform.ringcentral.com';
const RC_CLIENT_ID = '7yHuaGSWJhNeYFMWwHujb0';
const RC_CLIENT_SECRET = 'clr3C6NygUAedroX3f1YLSdmhX8CcwtOdcfFA8XRX8qF';
const RC_JWT = 'eyJraWQiOiI4NzYyZjU5OGQwNTk0NGRiODZiZjVjYTk3ODA0NzYwOCIsInR5cCI6IkpXVCIsImFsZyI6IlJTMjU2In0.eyJhdWQiOiJodHRwczovL3BsYXRmb3JtLnJpbmdjZW50cmFsLmNvbS9yZXN0YXBpL29hdXRoL3Rva2VuIiwic3ViIjoiMjc3NDMxMDUyIiwiaXNzIjoiaHR0cHM6Ly9wbGF0Zm9ybS5yaW5nY2VudHJhbC5jb20iLCJleHAiOjM5MTU3MjAzMDIsImlhdCI6MTc2ODIzNjY1NSwianRpIjoibE5iVlVobjFSb3lPeUVEVWpuNlNEdyJ9.Lum4lPGzVUIlTVN27LfmeBN62YCrAJNdp_nmTnpLFJzBz8pHncntBQaI9Ud79lfLHC-jZcvHlOb9027WNzWoi50rvAlgL_mgNDHWU5aElOmGQxc25WakcGLWWAFReCAwdUsdLRK28wmkqiWs8b-E6hi3BIQZjHHA9xDc9KLTFKk_4mJZs1xJ2hpyC2FLq68TSV09MudJMJcQ8JfS6ud2ahRkLfaVO4SAAuPqolED761WM1uM-q5daNaYqIpdTgwbgaCvinK4b4UdcNeaqkHqX9Xf8E0kqgH63HgzsBs-K63A5qcxQ96NcRVc3LqtjadiUalTg7Y7bH1nf7K_v4U85w';

/**
 * Get a specific call log record by ID
 * @param platform - RingCentral platform instance
 * @param callLogId - The call log resource ID
 * @returns Call log record
 */
async function getCallLogById(platform: any, callLogId: string) {
  try {
    console.log(`--- Fetching Call Log by ID: ${callLogId} ---`);
    const path = `/restapi/v1.0/account/~/call-log/${callLogId}`;
    const resp = await platform.get(path);
    const data = await resp.json();
    return data;
  } catch (e: any) {
    console.error(`Failed to get call log ${callLogId}:`, e.message || e);
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
 * Save call recording and insights to database
 */
async function saveCallRecordingToDB(
  supabase: any,
  userId: string,
  callRecord: any,
  insights: any
) {
  try {
    // Handle the actual API response structure
    // Summary is an array: [{ value: "...", start: 0, end: 12.93 }]
    // Transcript is an array: [{ text: "...", start: 0.36, end: 11.24, speakerId: "..." }]
    // speakerInfo is an array: [{ name: "...", speakerId: "...", ... }]
    
    const transcription = insights?.insights?.Transcript || null;
    const summaryArray = insights?.insights?.Summary || insights?.insights?.summary || null;
    const speakerInfoArray = insights?.speakerInfo || insights?.insights?.speakerInfo || null;

    // Extract summary text from array
    let summaryText = null;
    if (summaryArray) {
      if (Array.isArray(summaryArray) && summaryArray.length > 0) {
        // Get the first summary item's value
        summaryText = summaryArray[0]?.value || summaryArray[0]?.text || summaryArray[0]?.content || null;
        // If multiple summaries, combine them
        if (summaryArray.length > 1) {
          const allSummaries = summaryArray
            .map((s: any) => s.value || s.text || s.content)
            .filter(Boolean)
            .join(' ');
          if (allSummaries) summaryText = allSummaries;
        }
      } else if (typeof summaryArray === 'string') {
        summaryText = summaryArray;
      } else if (summaryArray.value) {
        summaryText = summaryArray.value;
      } else if (summaryArray.text) {
        summaryText = summaryArray.text;
      } else if (summaryArray.content) {
        summaryText = summaryArray.content;
      }
    }

    // Convert speakerInfo array to object for easier lookup
    let speakerInfo = null;
    if (speakerInfoArray) {
      if (Array.isArray(speakerInfoArray)) {
        speakerInfo = {};
        speakerInfoArray.forEach((speaker: any) => {
          if (speaker.speakerId) {
            speakerInfo[speaker.speakerId] = {
              name: speaker.name || null,
              phoneNumber: speaker.phoneNumber || null,
              accountId: speaker.accountId || null,
              extensionId: speaker.extensionId || null,
            };
          }
        });
      } else if (typeof speakerInfoArray === 'object') {
        speakerInfo = speakerInfoArray;
      }
    }

    const recordingData = {
      user_id: userId,
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

    return data;
  } catch (error: any) {
    console.error('Failed to save call recording to DB:', error);
    throw error;
  }
}

/**
 * GET endpoint - Fetch and save call recordings with insights
 * Query params:
 * - perPage: number of calls to fetch (default: 10)
 * - limit: number of calls to process (default: all)
 */
export async function GET(request: NextRequest) {
  try {
    // Verify authentication
    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      return NextResponse.json(
        { error: 'Unauthorized. Please log in.' },
        { status: 401 }
      );
    }

    // Check RingCentral credentials
    if (!RC_CLIENT_ID || !RC_CLIENT_SECRET || !RC_JWT) {
      console.error('RingCentral credentials missing:', {
        hasClientId: !!RC_CLIENT_ID,
        hasClientSecret: !!RC_CLIENT_SECRET,
        hasJWT: !!RC_JWT,
      });
      return NextResponse.json(
        { 
          error: 'RingCentral credentials not configured. Please check environment variables.',
          details: 'Missing RINGCENTRAL_CLIENT_ID, RINGCENTRAL_CLIENT_SECRET, or RINGCENTRAL_JWT'
        },
        { status: 500 }
      );
    }

    // Get query parameters
    const searchParams = request.nextUrl.searchParams;
    const perPage = parseInt(searchParams.get('perPage') || '10');
    const limit = searchParams.get('limit') ? parseInt(searchParams.get('limit')!) : null;

    // Initialize Supabase client
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
    
    if (!supabaseUrl || !supabaseAnonKey) {
      return NextResponse.json(
        { error: 'Server configuration error' },
        { status: 500 }
      );
    }

    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: authHeader,
        },
      },
    });

    // Verify user is authenticated
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized. Please log in.' },
        { status: 401 }
      );
    }

    // Initialize RingCentral SDK
    const rcsdk = new SDK({ server: RC_SERVER, clientId: RC_CLIENT_ID, clientSecret: RC_CLIENT_SECRET });
    const platform = rcsdk.platform();

    // Authenticate with RingCentral
    console.log('--- Authenticating with RingCentral ---');
    await platform.login({ jwt: RC_JWT });
    console.log('Authentication successful\n');

    // Get call logs
    const records = await getCallLogs(platform, perPage);
    
    if (records.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No call records found',
        processed: 0,
        saved: 0,
      });
    }

    // Find calls with recordings
    const callsWithRecordings = records.filter(
      (call: any) => call.recording && call.recording.id
    );

    if (callsWithRecordings.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No calls with recordings found',
        processed: 0,
        saved: 0,
      });
    }

    // Limit the number of calls to process if specified
    const callsToProcess = limit 
      ? callsWithRecordings.slice(0, limit)
      : callsWithRecordings;

    console.log(`\nProcessing ${callsToProcess.length} calls with recordings\n`);

    const results = {
      processed: 0,
      saved: 0,
      failed: 0,
      errors: [] as Array<{ callId: string; error: string }>,
    };

    // Process each call
    for (const call of callsToProcess) {
      try {
        const recordId = call.recording.id;
        const sessionId = call.telephonySessionId;

        let insights = null;

        // Try to get insights by record ID first
        try {
          insights = await getRingSenseInsightsByRecordId(platform, recordId);
        } catch (recordError: any) {
          console.log(`Failed to get insights by record ID: ${recordError.message}`);
          
          // Fallback to session ID
          if (sessionId) {
            try {
              insights = await getRingSenseInsightsBySessionId(platform, sessionId);
            } catch (sessionError: any) {
              console.error(`Failed to get insights by session ID: ${sessionError.message}`);
              results.failed++;
              results.errors.push({
                callId: call.id,
                error: `Failed to get insights: ${sessionError.message}`,
              });
              continue;
            }
          } else {
            results.failed++;
            results.errors.push({
              callId: call.id,
              error: `Failed to get insights: ${recordError.message}`,
            });
            continue;
          }
        }

        // Save to database
        await saveCallRecordingToDB(supabaseClient, user.id, call, insights);
        
        results.saved++;
        results.processed++;
        
        console.log(`✓ Saved call recording: ${call.id}`);
      } catch (error: any) {
        console.error(`Failed to process call ${call.id}:`, error);
        results.failed++;
        results.errors.push({
          callId: call.id,
          error: error.message || 'Unknown error',
        });
      }
    }

    return NextResponse.json({
      success: true,
      message: `Processed ${results.processed} calls, saved ${results.saved} recordings`,
      ...results,
    });
  } catch (error: any) {
    console.error('Error in RingSense insights route:', error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to fetch and save call recordings',
      },
      { status: 500 }
    );
  }
}

/**
 * POST endpoint - Fetch and save insights for a specific call recording
 * Body: { callLogId?: string, recordId?: string, sessionId?: string, leadId?: string }
 * 
 * Priority: callLogId > recordId > sessionId
 * If callLogId is provided, it will fetch that specific call log and extract the recording ID
 */
export async function POST(request: NextRequest) {
  try {
    // Verify authentication
    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      return NextResponse.json(
        { error: 'Unauthorized. Please log in.' },
        { status: 401 }
      );
    }

    // Check RingCentral credentials
    if (!RC_CLIENT_ID || !RC_CLIENT_SECRET || !RC_JWT) {
      return NextResponse.json(
        { error: 'RingCentral credentials not configured. Please check environment variables.' },
        { status: 500 }
      );
    }

    const body = await request.json();
    const { callLogId, recordId, sessionId, leadId } = body;

    if (!callLogId && !recordId && !sessionId) {
      return NextResponse.json(
        { error: 'Either callLogId, recordId, or sessionId is required' },
        { status: 400 }
      );
    }

    // Initialize Supabase client
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
    
    if (!supabaseUrl || !supabaseAnonKey) {
      return NextResponse.json(
        { error: 'Server configuration error' },
        { status: 500 }
      );
    }

    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: authHeader,
        },
      },
    });

    // Verify user is authenticated
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized. Please log in.' },
        { status: 401 }
      );
    }

    // Initialize RingCentral SDK
    const rcsdk = new SDK({ server: RC_SERVER, clientId: RC_CLIENT_ID, clientSecret: RC_CLIENT_SECRET });
    const platform = rcsdk.platform();

    // Authenticate with RingCentral
    await platform.login({ jwt: RC_JWT });

    let insights = null;
    let callRecord = null;
    let actualRecordId = recordId;
    let actualSessionId = sessionId;

    // Priority 1: If callLogId is provided, fetch that specific call log
    if (callLogId) {
      try {
        console.log(`Fetching call log by ID: ${callLogId}`);
        callRecord = await getCallLogById(platform, callLogId);
        
        // Extract recording ID and session ID from the call log
        if (callRecord.recording?.id) {
          actualRecordId = callRecord.recording.id;
          console.log(`Extracted recording ID: ${actualRecordId}`);
        }
        if (callRecord.telephonySessionId) {
          actualSessionId = callRecord.telephonySessionId;
          console.log(`Extracted session ID: ${actualSessionId}`);
        }
      } catch (error: any) {
        console.error(`Failed to fetch call log ${callLogId}:`, error.message);
        return NextResponse.json(
          { error: `Failed to fetch call log: ${error.message}` },
          { status: 500 }
        );
      }
    }

    // Get insights using the recording ID or session ID
    if (actualRecordId) {
      try {
        insights = await getRingSenseInsightsByRecordId(platform, actualRecordId);
      } catch (recordError: any) {
        console.log(`Failed to get insights by record ID: ${recordError.message}`);
        
        // Fallback to session ID if available
        if (actualSessionId) {
          try {
            insights = await getRingSenseInsightsBySessionId(platform, actualSessionId);
          } catch (sessionError: any) {
            return NextResponse.json(
              { error: `Failed to get insights: ${sessionError.message}` },
              { status: 500 }
            );
          }
        } else {
          return NextResponse.json(
            { error: `Failed to get insights: ${recordError.message}` },
            { status: 500 }
          );
        }
      }
    } else if (actualSessionId) {
      insights = await getRingSenseInsightsBySessionId(platform, actualSessionId);
    } else {
      return NextResponse.json(
        { error: 'No recording ID or session ID found' },
        { status: 400 }
      );
    }

    // If we don't have call record yet, create a minimal one
    if (!callRecord) {
      callRecord = {
        id: callLogId || `session-${actualSessionId}`,
        telephonySessionId: actualSessionId,
        recording: { id: actualRecordId },
      };
    }

    // Save to database
    const saved = await saveCallRecordingToDB(supabaseClient, user.id, callRecord, insights);

    // If leadId is provided, update the recording with lead_id
    if (leadId) {
      await supabaseClient
        .from('call_recordings')
        .update({ lead_id: leadId })
        .eq('id', saved.id);
    }

    return NextResponse.json({
      success: true,
      message: 'Call recording saved successfully',
      data: saved,
    });
  } catch (error: any) {
    console.error('Error in RingSense insights POST route:', error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to fetch and save call recording',
      },
      { status: 500 }
    );
  }
}

