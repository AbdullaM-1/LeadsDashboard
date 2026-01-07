import { NextRequest, NextResponse } from "next/server";

const API_BASE = "https://services.leadconnectorhq.com";

// Custom field IDs - update these with your actual GoHighLevel custom field IDs
// To find your custom field ID: Go to GoHighLevel > Settings > Custom Fields > find "Lead Status" > copy the ID
const CUSTOM_FIELD_IDS = {
  leadAge: "", // e.g. '6dvNaf7VhkQ9snc5vnjJ'
  callLogs: "",
  status: "", // dropdown (New | Qualified | Not-Qualified | CallBack)
  leadStatus: "", // IMPORTANT: Set this to your "Lead Status" custom field ID from GoHighLevel
};

const STATUS_OPTIONS = ["New", "Qualified", "Not-Qualified", "CallBack"];

interface LeadRow {
  [key: string]: string | undefined;
  // Original CSV column names
  "Lead Age"?: string;
  "First Name"?: string;
  "Middle Name"?: string;
  "Last Name"?: string;
  "Address"?: string;
  "Address 2"?: string;
  "City"?: string;
  "State"?: string;
  "Zip"?: string;
  "Phone"?: string;
  "Email"?: string;
  // Normalized versions
  first?: string;
  firstName?: string;
  middle?: string;
  last?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  address?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  postalCode?: string;
  status?: string;
  age?: string;
  logs?: string;
  callLogs?: string;
}

function buildCustomFields(values: {
  leadAge?: { value: string };
  callLogs?: { value: string };
  status?: { value: string };
  leadStatus?: { value: string };
}) {
  const customFields: Array<{ id: string; key: string; field_value: string }> =
    [];

  Object.entries(values).forEach(([key, config]) => {
    const id = CUSTOM_FIELD_IDS[key as keyof typeof CUSTOM_FIELD_IDS];
    if (!id || !config?.value) {
      return;
    }
    customFields.push({
      id,
      key,
      field_value: config.value,
    });
  });

  return customFields.length > 0 ? customFields : undefined;
}

function normalizeLeadData(row: LeadRow) {
  // Helper to get value by trying multiple possible keys
  const getValue = (...keys: string[]): string => {
    for (const key of keys) {
      const value = row[key];
      if (value && value.trim()) return value.trim();
    }
    return "";
  };

  // Map CSV columns to GoHighLevel fields
  // Handle both original CSV headers (with spaces) and normalized versions
  const firstName = getValue(
    "First Name",
    "first name",
    "First",
    "first",
    "firstName"
  );
  const lastName = getValue(
    "Last Name",
    "last name",
    "Last",
    "last",
    "lastName"
  );
  const name = `${firstName} ${lastName}`.trim() || firstName || lastName;
  const email = getValue("Email", "email");
  const phone = getValue("Phone", "phone");
  const address1 = getValue("Address", "address", "address1");
  const address2 = getValue("Address 2", "address 2", "address2");
  const city = getValue("City", "city");
  const state = getValue("State", "state");
  const postalCode = getValue("Zip", "zip", "postalCode", "Postal Code");
  const status = getValue("status", "Status") || STATUS_OPTIONS[0];
  const age = getValue("Lead Age", "lead age", "age", "leadAge");
  const logs = getValue("logs", "callLogs", "Call Logs") || "[]";

  return {
    firstName,
    lastName,
    name,
    email,
    phone,
    address1,
    address2,
    city,
    state,
    postalCode,
    status,
    age,
    logs,
  };
}

async function createContactInGHL(
  leadData: ReturnType<typeof normalizeLeadData>,
  token: string,
  locationId: string
) {
  const customFields = buildCustomFields({
    leadAge: leadData.age ? { value: leadData.age } : undefined,
    callLogs: leadData.logs ? { value: leadData.logs } : undefined,
    status: { value: leadData.status },
    leadStatus: { value: "New" }, // Always set Lead Status to "New" for imported contacts
  });

  const body: any = {
    firstName: leadData.firstName,
    lastName: leadData.lastName,
    name: leadData.name,
    email: leadData.email,
    locationId,
    phone: leadData.phone,
    tags: ["imported"],
  };

  // Add address fields if available
  if (leadData.address1) body.address1 = leadData.address1;
  if (leadData.address2) body.address2 = leadData.address2;
  if (leadData.city) body.city = leadData.city;
  if (leadData.state) body.state = leadData.state;
  if (leadData.postalCode) body.postalCode = leadData.postalCode;

  // Add custom fields if any are configured
  if (customFields) {
    body.customFields = customFields;
  }

  console.log("[GHL API] Creating contact with body:", JSON.stringify(body, null, 2));

  const response = await fetch(`${API_BASE}/contacts/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Version: "2021-07-28",
    },
    body: JSON.stringify(body),
  });

  console.log("[GHL API] Response status:", response.status);
  console.log("[GHL API] Response headers:", Object.fromEntries(response.headers.entries()));

  if (!response.ok) {
    const errorText = await response.text();
    console.error("[GHL API] Error response:", errorText);
    throw new Error(`GoHighLevel API error: ${response.status} ${errorText}`);
  }

  const responseData = await response.json();
  console.log("[GHL API] Success response:", responseData);
  return responseData;
}

export async function POST(request: NextRequest) {
  try {
    const token = process.env.NEXT_PUBLIC_GHL_ACCESS_TOKEN;
    const locationId = process.env.NEXT_PUBLIC_GHL_LOCATION_ID;

    console.log("[Import API] Token exists:", !!token);
    console.log("[Import API] Location ID exists:", !!locationId);

    if (!token || !locationId) {
      console.error("[Import API] Missing credentials");
      return NextResponse.json(
        {
          success: false,
          error: "GoHighLevel credentials not configured. Please check environment variables.",
        },
        { status: 500 }
      );
    }

    const leads: LeadRow[] = await request.json();
    console.log("[Import API] Received leads count:", leads?.length);
    console.log("[Import API] First lead sample:", leads?.[0]);

    if (!Array.isArray(leads) || leads.length === 0) {
      console.error("[Import API] Invalid or empty leads array");
      return NextResponse.json(
        { success: false, error: "No leads data provided" },
        { status: 400 }
      );
    }

    const results = {
      processed: 0,
      failed: 0,
      errors: [] as Array<{ row: number; error: string }>,
    };

    // Process leads sequentially to avoid rate limiting
    for (let i = 0; i < leads.length; i++) {
      try {
        // Log first row to see actual CSV structure
        if (i === 0) {
          console.log("[Import API] First row keys:", Object.keys(leads[i]));
          console.log("[Import API] First row sample:", leads[i]);
        }
        
        const normalizedData = normalizeLeadData(leads[i]);
        console.log(`[Import API] Processing row ${i + 1}:`, {
          firstName: normalizedData.firstName,
          lastName: normalizedData.lastName,
          email: normalizedData.email,
          phone: normalizedData.phone,
        });
        
        // Skip if essential fields are missing
        if (!normalizedData.email && !normalizedData.phone) {
          console.warn(`[Import API] Row ${i + 1} skipped: Missing both email and phone`);
          results.failed++;
          results.errors.push({
            row: i + 1,
            error: "Missing both email and phone",
          });
          continue;
        }

        const ghlResponse = await createContactInGHL(normalizedData, token, locationId);
        console.log(`[Import API] Row ${i + 1} created successfully:`, ghlResponse?.id || ghlResponse);
        results.processed++;
      } catch (error) {
        console.error(`[Import API] Failed to import lead at row ${i + 1}:`, error);
        results.failed++;
        results.errors.push({
          row: i + 1,
          error:
            error instanceof Error ? error.message : "Unknown error occurred",
        });
      }
    }

    console.log("[Import API] Final results:", results);
    return NextResponse.json({
      success: true,
      ...results,
    });
  } catch (error) {
    console.error("Import API error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to process import",
      },
      { status: 500 }
    );
  }
}

