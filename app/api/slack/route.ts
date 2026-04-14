import { auth } from "@/lib/auth";
import { NextRequest } from "next/server";

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
const USER_TOKEN = process.env.SLACK_USER_TOKEN!;
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase());

// Methods that require admin
const ADMIN_METHODS = ["conversations.archive", "chat.postMessage"];

// Methods that need user token (to read history without being a member)
const USER_TOKEN_METHODS = ["conversations.history"];

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { method, params } = await req.json();
  const isAdmin = ADMIN_EMAILS.includes(session.user.email.toLowerCase());

  if (ADMIN_METHODS.includes(method) && !isAdmin) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  // Use user token for history reads, bot token for everything else
  const token = USER_TOKEN_METHODS.includes(method) ? USER_TOKEN : BOT_TOKEN;

  const isGet = !ADMIN_METHODS.includes(method);
  let slackRes;

  if (isGet) {
    const qs = new URLSearchParams(params).toString();
    slackRes = await fetch(`https://slack.com/api/${method}?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } else {
    slackRes = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params),
    });
  }

  const data = await slackRes.json();
  return Response.json(data);
}
