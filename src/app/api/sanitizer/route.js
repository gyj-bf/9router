import { NextResponse } from "next/server";
import {
  getAllSanitizerRules,
  createSanitizerRule,
  updateSanitizerRule,
  deleteSanitizerRule,
} from "@/lib/db/repos/sanitizerRulesRepo.js";
import { invalidateSanitizerCache } from "../../../../open-sse/services/sanitizer.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rules = await getAllSanitizerRules();
    return NextResponse.json({ rules });
  } catch (error) {
    console.log("Error fetching sanitizer rules:", error);
    return NextResponse.json({ error: "Failed to fetch sanitizer rules" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { id, type, pattern, replacement, enabled, priority, provider } = body;
    if (!id || !type || !pattern) {
      return NextResponse.json({ error: "id, type, and pattern are required" }, { status: 400 });
    }
    if (!["regex", "exact"].includes(type)) {
      return NextResponse.json({ error: "type must be 'regex' or 'exact'" }, { status: 400 });
    }
    // Validate regex if type is regex
    if (type === "regex") {
      try { new RegExp(pattern); } catch (e) {
        return NextResponse.json({ error: `Invalid regex: ${e.message}` }, { status: 400 });
      }
    }
    const rule = await createSanitizerRule({ id, type, pattern, replacement, enabled, priority, provider });
    invalidateSanitizerCache();
    return NextResponse.json({ rule }, { status: 201 });
  } catch (error) {
    console.log("Error creating sanitizer rule:", error);
    return NextResponse.json({ error: "Failed to create sanitizer rule" }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const body = await request.json();
    const { id, ...changes } = body;
    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }
    await updateSanitizerRule(id, changes);
    invalidateSanitizerCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.log("Error updating sanitizer rule:", error);
    return NextResponse.json({ error: "Failed to update sanitizer rule" }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id query param is required" }, { status: 400 });
    }
    await deleteSanitizerRule(id);
    invalidateSanitizerCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.log("Error deleting sanitizer rule:", error);
    return NextResponse.json({ error: "Failed to delete sanitizer rule" }, { status: 500 });
  }
}
