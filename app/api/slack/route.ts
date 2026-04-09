import { auth } from "@/lib/auth";
import { NextRequest } from "next/server";

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase());

// Méthodes réservées aux admins
const ADMIN_METHODS = ["conversations.archive", "chat.postMessage"];

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

  const isGet = !ADMIN_METHODS.includes(method);
  let slackRes;

  if (isGet) {
    const qs = new URLSearchParams(params).toString();
    slackRes = await fetch(`https://slack.com/api/${method}?${qs}`, {
      headers: { Authorization: `Bearer ${BOT_TOKEN}` },
    });
  } else {
    slackRes = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params),
    });
  }

  const data = await slackRes.json();
  return Response.json(data);
}
