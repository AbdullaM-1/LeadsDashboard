import { NextRequest, NextResponse } from "next/server";

// Prefer using env vars; here we read IRS_LOGICS_SECRET
const API_KEY = process.env.IRS_LOGICS_SECRET || '8cf8b8b0914a4531aff6a7132da19f6f';
const SECRET_TOKEN = process.env.IRS_LOGICS_TOKEN || 'ad0c5006-f205-4c04-bd3a-616ad23e285c'; // Basic Auth password
const ENDPOINT = 'https://integrated.logiqs.com/publicapi/V4/Case/CaseFile'; // public API (Basic Auth)

// Helper function to format phone number to (XXX)XXX-XXXX format
function formatPhoneNumber(phone: string | undefined): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)})${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits[0] === '1') {
    const tenDigits = digits.slice(1);
    return `(${tenDigits.slice(0, 3)})${tenDigits.slice(3, 6)}-${tenDigits.slice(6)}`;
  }
  return phone;
}

async function pushToIrsLogics(payload: any) {
  console.log('[irs] Payload:', JSON.stringify(payload, null, 2));
  const authHeader = 'Basic ' + Buffer.from(`${API_KEY}:${SECRET_TOKEN}`).toString('base64');
  const url = ENDPOINT;
  console.log('[irs] Final URL:', url);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader
    },
    body: JSON.stringify(payload)
  });

  console.log('[irs] Response status:', response.status);
  console.log('[irs] Response headers:', Object.fromEntries(response.headers.entries()));

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`IRS Logics error ${response.status}: ${text}`);
  }
  console.log('[irs] Response body:', text);
  return text;
}

export async function POST(request: NextRequest) {
  try {
    console.log('[irs] Using API key prefix:', API_KEY.slice(0, 6));
    console.log('[irs] Using secret token prefix:', SECRET_TOKEN ? SECRET_TOKEN.slice(0, 6) : 'missing');
    console.log('[irs] Endpoint:', ENDPOINT);

    const leadData = await request.json();
    console.log('[irs] Received lead data:', JSON.stringify(leadData, null, 2));

    // Validate required fields
    if (!leadData.last_name || leadData.last_name.trim() === '') {
      return NextResponse.json(
        {
          success: false,
          error: "LastName is required and cannot be empty",
        },
        { status: 400 }
      );
    }

    if (!leadData.first_name || leadData.first_name.trim() === '') {
      return NextResponse.json(
        {
          success: false,
          error: "FirstName is required and cannot be empty",
        },
        { status: 400 }
      );
    }

    // Build payload — align fields to your tenant's required schema
    // Only include fields that have values (don't send empty strings)
    const payload: any = {
      LastName: leadData.last_name.trim(),
      FirstName: leadData.first_name.trim(),
      ProductID: 1,
      StatusID: 1,
    };

    // Add optional fields only if they have values
    if (leadData.email && leadData.email.trim()) {
      payload.Email = leadData.email.trim();
    }

    const formattedPhone = formatPhoneNumber(leadData.phone);
    if (formattedPhone) {
      payload.HomePhone = formattedPhone;
      payload.CellPhone = formattedPhone;
    }

    // WorkPhone - only add if you have a work phone field
    // payload.WorkPhone = '';

    if (leadData.address_line1 && leadData.address_line1.trim()) {
      payload.Address = leadData.address_line1.trim();
    }

    if (leadData.city && leadData.city.trim()) {
      payload.City = leadData.city.trim();
    }

    if (leadData.state && leadData.state.trim()) {
      payload.State = leadData.state.trim();
    }

    if (leadData.postal_code && leadData.postal_code.trim()) {
      payload.Zip = leadData.postal_code.trim();
    }

    const result = await pushToIrsLogics(payload);
    
    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('Failed:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to submit to IRS Logics",
      },
      { status: 500 }
    );
  }
}

