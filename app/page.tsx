"use client";
import { useState, useEffect, useCallback } from "react";
import { signOut, useSession } from "next-auth/react";

const NAMING_PREFIXES = ["proj-","team-","help-","temp-","annonce-","general","random","ext-","social-","all-","data-","ops-","rh-","tech-","product-","design-","marketing-","sales-","it-"];

const slackApi = async (method: string, params: Record<string, any> = {}) => {
  const res = await fetch("/api/slack", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  return res.json();
};

const daysSince = (ts: string | null) =>
  ts ? Math.floor((Date.now() / 1000 - parseFloat(ts)) / 86400) : 999;

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

async function batchedMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  batchSize = 10,
  delayMs = 500
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    if (i + batchSize < items.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return results;
}

const TABS = ["kpi", "channels", "actions", "log"] as const;
const TAB_LABELS: Record<string, string> = {
  kpi: "📊 KPIs",
  channels: "📢 Channels",
  actions: "🚀 Actions",
  log: "📋 Log",
};

export default function Dashboard() {
  const { data: session } = useSession();
  const isAdmin = (session?.user as any)?.isAdmin ?? false;
  const email = session?.user?.email ?? "";

  const [loading, setLoading] = useState(false);
  const [loadMsg, setLoadMsg] = useState("");
  const [data, setData] = useState<any>(null);
  const [log, setLog] = useState<string[]>([]);
  const [tab, setTab] = useState<string>("kpi");
  const [chanFilter, setChanFilter] = useState("all");
  const [chanSearch, setChanSearch] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [expandedChan, setExpandedChan] = useState<string | null>(null);
  const [alertOwner, setAlertOwner] = useState("all");
  // Button feedback state: key = button id, value = "sent" | null
  const [sentFeedback, setSentFeedback] = useState<Record<string, boolean>>({});

  const addLog = (msg: string) =>
    setLog((l) => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...l]);

  const showFeedback = (key: string) => {
    setSentFeedback((prev) => ({ ...prev, [key]: true }));
    setTimeout(() => setSentFeedback((prev) => ({ ...prev, [key]: false })), 3000);
  };

  // ── LOAD ALL DATA ─────────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    setLoading(true);
    setData(null);
    setLoadMsg("Fetching channels...");

    try {
      // 1. Channels
      let channels: any[] = [], cursor = "";
      do {
        const r = await slackApi("conversations.list", {
          types: "public_channel,private_channel",
          limit: 200,
          exclude_archived: true,
          ...(cursor ? { cursor } : {}),
        });
        channels = [...channels, ...(r.channels || [])];
        cursor = r.response_metadata?.next_cursor || "";
      } while (cursor);

      // 2. Members (include deactivated for owner name resolution)
      setLoadMsg(`${channels.length} channels. Fetching members...`);
      let members: any[] = [], mc = "";
      do {
        const r = await slackApi("users.list", {
          limit: 200,
          ...(mc ? { cursor: mc } : {}),
        });
        const all = (r.members || []).filter(
          (m: any) => !m.is_bot && m.id !== "USLACKBOT"
        );
        members = [...members, ...all];
        mc = r.response_metadata?.next_cursor || "";
      } while (mc);

      const memberMap: Record<string, string> = {};
      let externalCount = 0;
      const activeCount = members.filter((m: any) => !m.deleted).length;

      for (const m of members) {
        memberMap[m.id] = m.real_name || m.profile?.display_name || m.name;
        if (!m.deleted) {
          const memberEmail: string = m.profile?.email || "";
          if (memberEmail && !memberEmail.endsWith("@vizzia.fr")) {
            externalCount++;
          }
        }
      }

      // 3. Compliance check
      const withIssues = channels.map((ch: any) => {
        const issues: string[] = [];
        if (!NAMING_PREFIXES.some((p) => ch.name.startsWith(p))) issues.push("naming");
        if (!ch.topic?.value) issues.push("topic");
        if (!ch.purpose?.value) issues.push("description");
        const ownerName = ch.creator ? (memberMap[ch.creator] || ch.creator) : "Unknown";
        const ownerDeactivated = ch.creator
          ? (members.find((m: any) => m.id === ch.creator)?.deleted ?? false)
          : false;
        // Keep creator ID for Slack tagging
        return { ...ch, issues, ownerName, ownerDeactivated, lastTs: null, dormant: false };
      });

      // 4. Activity — batches of 10 in parallel
      setLoadMsg(`Fetching activity (${channels.length} channels)...`);
      let completed = 0;
      const chanStats: Record<string, string | null> = {};

      await batchedMap(
        withIssues,
        async (ch) => {
          try {
            const r = await slackApi("conversations.history", { channel: ch.id, limit: 1 });
            chanStats[ch.id] = r.messages?.[0]?.ts || null;
          } catch {
            chanStats[ch.id] = null;
          }
          completed++;
          if (completed % 20 === 0) setLoadMsg(`Activity ${completed}/${channels.length}...`);
        },
        10,
        500
      );

      // 5. Merge activity
      const finalChannels = withIssues.map((ch: any) => ({
        ...ch,
        lastTs: chanStats[ch.id] ?? null,
        dormant: daysSince(chanStats[ch.id] ?? null) > 90,
      }));

      const helpChan = finalChannels.find((c: any) => c.name === "help-slack");
      const pubCount = finalChannels.filter((c: any) => !c.is_private).length;
      const nonCompliant = finalChannels.filter((c: any) => c.issues.length > 0);
      const dormant = finalChannels.filter((c: any) => c.dormant && !c.name.startsWith("temp-"));
      const tempDormant = finalChannels.filter((c: any) => c.name.startsWith("temp-") && c.dormant);

      setData({
        channels: finalChannels,
        members: members.filter((m: any) => !m.deleted),
        nonCompliant,
        dormant,
        tempDormant,
        helpChan,
        pubCount,
        externalCount,
        activeCount,
        withDesc: finalChannels.filter((c: any) => c.purpose?.value).length,
        withTopic: finalChannels.filter((c: any) => c.topic?.value).length,
        namingCompliant: finalChannels.filter((c: any) => !c.issues.includes("naming")).length,
        total: finalChannels.length,
      });

      addLog(`✅ ${channels.length} channels, ${activeCount} members, activity loaded`);
    } catch (e: any) {
      addLog(`❌ Error: ${e.message}`);
    }

    setLoading(false);
    setLoadMsg("");
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // ── ADMIN ACTIONS ─────────────────────────────────────────────────────────

  const sendNonCompliantOne = async (ch: any) => {
    if (!data?.helpChan) { addLog("❌ #help-slack not found"); return; }
    const issues = ch.issues
      .map((i: string) =>
        i === "naming" ? "❌ Naming" : i === "topic" ? "❌ Topic" : "❌ Description"
      )
      .join(", ");
    const tag = ch.creator ? `<@${ch.creator}>` : ch.ownerName;
    const r = await slackApi("chat.postMessage", {
      channel: data.helpChan.id,
      text: `📋 *Non-compliant channel*: #${ch.name}\n${tag} please fix: ${issues}`,
    });
    if (r.ok) { addLog(`✅ Notification sent for #${ch.name}`); showFeedback(`one-${ch.id}`); }
    else addLog(`❌ Failed for #${ch.name}: ${r.error}`);
  };

  // Batch non-compliant — grouped by owner, one line per channel
  const sendNonCompliantAll = async () => {
    if (!data?.helpChan) { addLog("❌ #help-slack not found"); return; }
    if (data.nonCompliant.length === 0) { addLog("✅ No non-compliant channels"); return; }
    const date = new Date().toLocaleDateString("en-GB");

    // Group by creator ID
    const byOwner: Record<string, any[]> = {};
    for (const c of data.nonCompliant) {
      const key = c.creator || c.ownerName;
      if (!byOwner[key]) byOwner[key] = [];
      byOwner[key].push(c);
    }

    const lines = Object.entries(byOwner)
      .map(([creatorId, chans]) => {
        const tag = creatorId.startsWith("U") ? `<@${creatorId}>` : creatorId;
        const chanLines = (chans as any[])
          .map((c: any) => {
            const issues = c.issues
              .map((i: string) =>
                i === "naming" ? "❌ Naming" : i === "topic" ? "❌ Topic" : "❌ Desc"
              )
              .join(", ");
            return `    • #${c.name} — ${issues}`;
          })
          .join("\n");
        return `${tag}\n${chanLines}`;
      })
      .join("\n\n");

    const r = await slackApi("chat.postMessage", {
      channel: data.helpChan.id,
      text: `📋 *Non-compliant channels — ${date}*\n\n${lines}`,
    });
    if (r.ok) { addLog(`✅ Batch sent for ${data.nonCompliant.length} non-compliant channels`); showFeedback("batch-noncompliant"); }
    else addLog(`❌ Send failed: ${r.error}`);
  };

  // Alert by specific owner — grouped, one line per channel
  const sendAlertForOwner = async () => {
    if (!data?.helpChan) { addLog("❌ #help-slack not found"); return; }
    if (alertOwner === "all") { addLog("❌ Please select a specific owner"); return; }
    const ownerChannels = data.nonCompliant.filter((c: any) => c.ownerName === alertOwner);
    if (ownerChannels.length === 0) { addLog(`✅ No non-compliant channels for ${alertOwner}`); return; }

    const date = new Date().toLocaleDateString("en-GB");
    const creatorId = ownerChannels[0]?.creator;
    const tag = creatorId?.startsWith("U") ? `<@${creatorId}>` : alertOwner;

    const chanLines = ownerChannels
      .map((c: any) => {
        const issues = c.issues
          .map((i: string) =>
            i === "naming" ? "❌ Naming" : i === "topic" ? "❌ Topic" : "❌ Desc"
          )
          .join(", ");
        return `• #${c.name} — ${issues}`;
      })
      .join("\n");

    const r = await slackApi("chat.postMessage", {
      channel: data.helpChan.id,
      text: `Non-compliant channels for ${tag} — ${date}\n\n${chanLines}\n\nPlease update these channels to meet Vizzia's naming standards.`,
    });
    if (r.ok) { addLog(`✅ Alert sent for ${alertOwner} (${ownerChannels.length} channels)`); showFeedback("alert-owner"); }
    else addLog(`❌ Send failed: ${r.error}`);
  };

  const alertDormant = async () => {
    if (!data?.helpChan) { addLog("❌ #help-slack not found"); return; }
    if (data.dormant.length === 0) { addLog("✅ No inactive channels"); return; }
    const date = new Date().toLocaleDateString("en-GB");

    // Group by owner
    const byOwner: Record<string, any[]> = {};
    for (const c of data.dormant) {
      const key = c.creator || c.ownerName;
      if (!byOwner[key]) byOwner[key] = [];
      byOwner[key].push(c);
    }

    const lines = Object.entries(byOwner)
      .map(([creatorId, chans]) => {
        const tag = creatorId.startsWith("U") ? `<@${creatorId}>` : creatorId;
        const chanLines = (chans as any[])
          .map((c: any) => `    • #${c.name} — inactive for ${daysSince(c.lastTs)} days`)
          .join("\n");
        return `${tag}\n${chanLines}`;
      })
      .join("\n\n");

    const r = await slackApi("chat.postMessage", {
      channel: data.helpChan.id,
      text: `💤 *Inactive channels (+90 days) — ${date}*\n\n${lines}\n\nPlease confirm if these channels can be archived.`,
    });
    if (r.ok) { addLog(`✅ Batch sent for ${data.dormant.length} inactive channels`); showFeedback("batch-dormant"); }
    else addLog(`❌ Send failed: ${r.error}`);
  };

  const archiveTemp = async () => {
    let count = 0;
    for (const c of data.tempDormant) {
      const r = await slackApi("conversations.archive", { channel: c.id });
      if (r.ok) count++;
    }
    addLog(`✅ ${count} temp- channel(s) archived`);
    showFeedback("archive-temp");
    loadData();
  };

  // ── STYLES ────────────────────────────────────────────────────────────────
  const s = {
    wrap: { fontFamily: "Inter,sans-serif", background: "#0f0f1a", minHeight: "100vh", color: "#e2e2f0", padding: "20px" },
    card: { background: "#1a1a2e", borderRadius: 14, padding: "18px 20px", border: "1px solid #2d2d44", marginBottom: 14 },
    btn: (col = "#4f46e5", sent = false) => ({
      background: sent ? "linear-gradient(135deg,#059669,#059669bb)" : `linear-gradient(135deg,${col},${col}bb)`,
      border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff",
      fontWeight: 600, fontSize: 12, cursor: sent ? "default" : "pointer",
      marginRight: 6, marginBottom: 4, transition: "background 0.3s",
    } as React.CSSProperties),
    badge: (ok: boolean) => ({ display: "inline-block", borderRadius: 5, padding: "2px 7px", fontSize: 10, fontWeight: 700, background: ok ? "#14532d" : "#450a0a", color: ok ? "#4ade80" : "#f87171" } as React.CSSProperties),
    tabBtn: (a: boolean) => ({ padding: "8px 16px", borderRadius: 8, border: "none", background: a ? "#4f46e5" : "transparent", color: a ? "#fff" : "#6b6b8a", fontWeight: 600, fontSize: 12, cursor: "pointer" } as React.CSSProperties),
    input: { background: "#0f0f1a", border: "1px solid #2d2d44", borderRadius: 9, padding: "10px 14px", color: "#e2e2f0", fontSize: 13 } as React.CSSProperties,
    select: { background: "#1a1a2e", border: "1px solid #2d2d44", borderRadius: 8, padding: "7px 12px", color: "#e2e2f0", fontSize: 12, cursor: "pointer" } as React.CSSProperties,
    row: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid #2d2d44", gap: 8, flexWrap: "wrap" } as React.CSSProperties,
    filterBtn: (active: boolean) => ({
      padding: "6px 14px", borderRadius: 20,
      border: `1px solid ${active ? "#4f46e5" : "#2d2d44"}`,
      background: active ? "#4f46e5" : "transparent",
      color: active ? "#fff" : "#9ca3af",
      fontWeight: active ? 600 : 400, fontSize: 12,
      cursor: "pointer", whiteSpace: "nowrap",
    } as React.CSSProperties),
  };

  const FILTERS = [
    { key: "all", label: "All" },
    { key: "noncompliant", label: "⚠️ Non-compliant" },
    { key: "dormant", label: "💤 Inactive" },
    { key: "temp", label: "🗑️ Temp-" },
  ];

  const ownerList: string[] = data
    ? Array.from(new Set(data.channels.map((c: any) => c.ownerName as string)))
        .filter((o) => o && o !== "Unknown")
        .sort((a, b) => (a as string).localeCompare(b as string)) as string[]
    : [];

  const nonCompliantOwners: string[] = data
    ? Array.from(new Set(data.nonCompliant.map((c: any) => c.ownerName as string)))
        .filter((o) => o && o !== "Unknown")
        .sort((a, b) => (a as string).localeCompare(b as string)) as string[]
    : [];

  const filteredChannels = (data?.channels || [])
    .filter((c: any) => {
      if (chanFilter === "noncompliant") return c.issues.length > 0;
      if (chanFilter === "dormant") return c.dormant;
      if (chanFilter === "temp") return c.name.startsWith("temp-");
      return true;
    })
    .filter((c: any) => ownerFilter === "all" || c.ownerName === ownerFilter)
    .filter((c: any) => c.name.includes(chanSearch.toLowerCase()));

  const kpiGrid4 = { display: "grid" as const, gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 10 };
  const kpiPrimary = { background: "#1a1a2e", borderRadius: 12, padding: "18px 14px", border: "1px solid #2d2d44", textAlign: "center" as const };
  const kpiSecondary = { background: "#13131f", borderRadius: 12, padding: "14px", border: "1px solid #2d2d44", textAlign: "center" as const };

  return (
    <div style={s.wrap}>
      {/* ── HEADER ── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 20 }}>⚡ Vizzia Slack Health Dashboard</div>
          <div style={{ fontSize: 12, color: "#6b6b8a" }}>
            {email}
            {isAdmin && (
              <span style={{ marginLeft: 8, background: "#1e1b4b", color: "#818cf8", borderRadius: 6, padding: "2px 8px", fontSize: 11 }}>✦ Admin</span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={loadData} disabled={loading} style={s.btn("#059669")}>
            {loading ? `⏳ ${loadMsg}` : "🔄 Refresh"}
          </button>
          <button onClick={() => signOut({ callbackUrl: "/login" })} style={s.btn("#6b6b8a")}>
            Sign out
          </button>
        </div>
      </div>

      {/* ── TABS ── */}
      <div style={{ display: "flex", gap: 4, marginBottom: 18, background: "#1a1a2e", borderRadius: 10, padding: 4, width: "fit-content", flexWrap: "wrap" }}>
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} style={s.tabBtn(tab === t)}>{TAB_LABELS[t]}</button>
        ))}
      </div>

      {/* ── LOADING ── */}
      {loading && (
        <div style={{ ...s.card, textAlign: "center", color: "#6b6b8a", marginBottom: 14 }}>
          <div style={{ fontSize: 20, marginBottom: 6 }}>⏳</div>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{loadMsg || "Loading..."}</div>
        </div>
      )}

      {/* ── KPIs ── */}
      {tab === "kpi" && data && (
        <>
          <div style={kpiGrid4}>
            <div style={kpiPrimary}>
              <div style={{ fontSize: 20 }}>📢</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: "#818cf8", margin: "6px 0" }}>{data.pubCount}</div>
              <div style={{ fontSize: 12, color: "#e2e2f0", fontWeight: 600 }}>Total channels</div>
              <div style={{ fontSize: 11, color: "#6b6b8a", marginTop: 2 }}>public channels only</div>
            </div>
            <div style={kpiPrimary}>
              <div style={{ fontSize: 20 }}>👥</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: "#f472b6", margin: "6px 0" }}>{data.activeCount}</div>
              <div style={{ fontSize: 12, color: "#e2e2f0", fontWeight: 600 }}>Members</div>
              <div style={{ fontSize: 11, color: "#6b6b8a", marginTop: 2 }}>active, excl. bots</div>
            </div>
            <div style={kpiPrimary}>
              <div style={{ fontSize: 20 }}>🌍</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: "#f87171", margin: "6px 0" }}>{data.externalCount}</div>
              <div style={{ fontSize: 12, color: "#e2e2f0", fontWeight: 600 }}>External members</div>
              <div style={{ fontSize: 11, color: "#6b6b8a", marginTop: 2 }}>non @vizzia.fr</div>
            </div>
            <div style={kpiPrimary}>
              <div style={{ fontSize: 20 }}>🗑️</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: "#c084fc", margin: "6px 0" }}>{data.tempDormant.length}</div>
              <div style={{ fontSize: 12, color: "#e2e2f0", fontWeight: 600 }}>Temp- to archive</div>
              <div style={{ fontSize: 11, color: "#6b6b8a", marginTop: 2 }}>inactive 90+ days</div>
            </div>
          </div>

          <div style={{ ...kpiGrid4, marginBottom: 14 }}>
            {[
              { label: "Inactive +90d", val: data.dormant.length, icon: "💤", color: "#6b6b8a" },
              { label: "With description", val: `${pct(data.withDesc, data.total)}%`, icon: "📝", color: "#34d399" },
              { label: "With topic", val: `${pct(data.withTopic, data.total)}%`, icon: "🏷️", color: "#60a5fa" },
              { label: "Naming compliant", val: `${pct(data.namingCompliant, data.total)}%`, icon: "✅", color: "#4ade80" },
            ].map((k) => (
              <div key={k.label} style={kpiSecondary}>
                <div style={{ fontSize: 18 }}>{k.icon}</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: k.color, margin: "4px 0" }}>{k.val}</div>
                <div style={{ fontSize: 11, color: "#6b6b8a" }}>{k.label}</div>
              </div>
            ))}
          </div>

          <div style={s.card}>
            <div style={{ fontWeight: 700, marginBottom: 10 }}>Channel compliance</div>
            {[
              { label: "Naming compliant", val: pct(data.namingCompliant, data.total), color: "#34d399" },
              { label: "Description filled", val: pct(data.withDesc, data.total), color: "#60a5fa" },
              { label: "Topic filled", val: pct(data.withTopic, data.total), color: "#f59e0b" },
            ].map((k) => (
              <div key={k.label} style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                  <span>{k.label}</span><span style={{ color: k.color, fontWeight: 700 }}>{k.val}%</span>
                </div>
                <div style={{ background: "#0f0f1a", borderRadius: 6, height: 8, overflow: "hidden" }}>
                  <div style={{ width: `${k.val}%`, background: k.color, height: "100%", borderRadius: 6 }} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── CHANNELS ── */}
      {tab === "channels" && data && (
        <div style={s.card}>
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
            {FILTERS.map((f) => {
              const count =
                f.key === "all" ? data.total :
                f.key === "noncompliant" ? data.nonCompliant.length :
                f.key === "dormant" ? data.dormant.length :
                data.channels.filter((c: any) => c.name.startsWith("temp-")).length;
              return (
                <button key={f.key} onClick={() => setChanFilter(f.key)} style={s.filterBtn(chanFilter === f.key)}>
                  {f.label} <span style={{ opacity: 0.7, marginLeft: 4 }}>{count}</span>
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
            <input
              value={chanSearch}
              onChange={(e) => setChanSearch(e.target.value)}
              placeholder="🔍 Search a channel..."
              style={{ ...s.input, width: 220, padding: "7px 12px" }}
            />
            <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)} style={s.select}>
              <option value="all">All owners</option>
              {ownerList.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <span style={{ fontSize: 12, color: "#6b6b8a" }}>{filteredChannels.length} results</span>
          </div>
          <div style={{ maxHeight: 500, overflowY: "auto" }}>
            {filteredChannels.map((c: any) => (
              <div key={c.id}>
                <div onClick={() => setExpandedChan(expandedChan === c.id ? null : c.id)} style={{ ...s.row, cursor: "pointer" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontFamily: "monospace", fontSize: 13 }}>#{c.name}</span>
                    {c.is_private && <span style={{ fontSize: 11, color: "#6b6b8a" }}>🔒</span>}
                    <span style={{ fontSize: 11, color: c.ownerDeactivated ? "#6b6b8a" : "#818cf8", background: "#1e1b4b", borderRadius: 5, padding: "1px 7px" }}>
                      👤 {c.ownerName}{c.ownerDeactivated ? " (inactive)" : ""}
                    </span>
                    {c.dormant && (
                      <span style={{ fontSize: 10, background: "#1c1917", color: "#78716c", borderRadius: 5, padding: "1px 6px" }}>
                        💤 {daysSince(c.lastTs)}d
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {c.issues.length === 0
                      ? <span style={s.badge(true)}>✅ Compliant</span>
                      : c.issues.map((i: string) => (
                          <span key={i} style={s.badge(false)}>
                            {i === "naming" ? "naming" : i === "topic" ? "topic" : "desc"}
                          </span>
                        ))}
                  </div>
                </div>
                {expandedChan === c.id && (
                  <div style={{ background: "#0f0f1a", borderRadius: 8, padding: "12px 14px", marginBottom: 8, fontSize: 12 }}>
                    <div style={{ color: "#6b6b8a", marginBottom: 4 }}>
                      📝 Description: <span style={{ color: c.purpose?.value ? "#e2e2f0" : "#f87171" }}>{c.purpose?.value || "Not set"}</span>
                    </div>
                    <div style={{ color: "#6b6b8a", marginBottom: 4 }}>
                      🏷️ Topic: <span style={{ color: c.topic?.value ? "#e2e2f0" : "#f87171" }}>{c.topic?.value || "Not set"}</span>
                    </div>
                    <div style={{ color: "#6b6b8a", marginBottom: 4 }}>
                      ⏱️ Last activity: <span style={{ color: "#e2e2f0" }}>
                        {c.lastTs ? `${daysSince(c.lastTs)} days ago` : "No messages"}
                      </span>
                    </div>
                    <div style={{ color: "#6b6b8a", marginBottom: 8 }}>
                      👤 Owner: <span style={{ color: "#818cf8" }}>{c.ownerName}{c.ownerDeactivated ? " (inactive)" : ""}</span>
                    </div>
                    {isAdmin && c.issues.length > 0 && (
                      <button
                        onClick={() => sendNonCompliantOne(c)}
                        style={s.btn("#dc2626", !!sentFeedback[`one-${c.id}`])}
                      >
                        {sentFeedback[`one-${c.id}`] ? "✅ Sent!" : "📩 Notify owner"}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── ACTIONS ── */}
      {tab === "actions" && (
        <div>
          {!isAdmin ? (
            <div style={{ ...s.card, borderColor: "#dc2626", textAlign: "center", color: "#f87171" }}>
              🔒 Admin access only
            </div>
          ) : data ? (
            <>
              {/* Batch non-compliant */}
              <div style={s.card}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>📋 Non-compliant channels</div>
                <div style={{ fontSize: 12, color: "#6b6b8a", marginBottom: 10 }}>
                  Sends a single recap to #help-slack, grouped by owner, listing all {data.nonCompliant.length} non-compliant channels.
                </div>
                <button
                  onClick={sendNonCompliantAll}
                  style={s.btn("#dc2626", !!sentFeedback["batch-noncompliant"])}
                >
                  {sentFeedback["batch-noncompliant"] ? "✅ Sent!" : `📩 Send batch non-compliant channels (${data.nonCompliant.length})`}
                </button>
              </div>

              {/* Alert by owner */}
              <div style={s.card}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>👤 Alert by owner</div>
                <div style={{ fontSize: 12, color: "#6b6b8a", marginBottom: 12 }}>
                  Send a targeted alert to #help-slack for all non-compliant channels of a specific owner.
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <select
                    value={alertOwner}
                    onChange={(e) => { setAlertOwner(e.target.value); setSentFeedback((p) => ({ ...p, "alert-owner": false })); }}
                    style={{ ...s.select, minWidth: 200 }}
                  >
                    <option value="all">Select an owner...</option>
                    {nonCompliantOwners.map((o) => {
                      const count = data.nonCompliant.filter((c: any) => c.ownerName === o).length;
                      return <option key={o} value={o}>{o} ({count} channels)</option>;
                    })}
                  </select>
                  <button
                    onClick={sendAlertForOwner}
                    disabled={alertOwner === "all"}
                    style={{ ...s.btn("#7c3aed", !!sentFeedback["alert-owner"]), opacity: alertOwner === "all" ? 0.5 : 1 }}
                  >
                    {sentFeedback["alert-owner"] ? "✅ Sent!" : "📩 Send alert for this owner"}
                  </button>
                </div>
              </div>

              {/* Batch inactive */}
              <div style={s.card}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>💤 Inactive channels</div>
                <div style={{ fontSize: 12, color: "#6b6b8a", marginBottom: 10 }}>
                  Sends a single recap to #help-slack, grouped by owner, for the {data.dormant.length} channels inactive for 90+ days.
                </div>
                <button
                  onClick={alertDormant}
                  style={s.btn("#d97706", !!sentFeedback["batch-dormant"])}
                >
                  {sentFeedback["batch-dormant"] ? "✅ Sent!" : `⚠️ Send batch inactive channels (${data.dormant.length})`}
                </button>
              </div>

              {/* Archive temp */}
              <div style={s.card}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>🗑️ Archive inactive temp- channels</div>
                <div style={{ fontSize: 12, color: "#6b6b8a", marginBottom: 8 }}>
                  {data.tempDormant.length} temp- channel(s) inactive for 90+ days.
                </div>
                <div style={{ maxHeight: 100, overflowY: "auto", marginBottom: 10 }}>
                  {data.tempDormant.map((c: any) => (
                    <div key={c.id} style={{ fontSize: 12, fontFamily: "monospace", padding: "2px 0", borderBottom: "1px solid #2d2d44" }}>
                      #{c.name} <span style={{ color: "#6b6b8a" }}>({daysSince(c.lastTs)}d)</span>
                    </div>
                  ))}
                  {data.tempDormant.length === 0 && (
                    <div style={{ color: "#4ade80", fontSize: 12 }}>✅ No temp- channels to archive</div>
                  )}
                </div>
                {data.tempDormant.length > 0 && (
                  <button
                    onClick={archiveTemp}
                    style={s.btn("#7c3aed", !!sentFeedback["archive-temp"])}
                  >
                    {sentFeedback["archive-temp"] ? "✅ Archived!" : `🗑️ Archive (${data.tempDormant.length})`}
                  </button>
                )}
              </div>
            </>
          ) : (
            <div style={{ ...s.card, textAlign: "center", color: "#6b6b8a" }}>Loading data...</div>
          )}
        </div>
      )}

      {/* ── LOG ── */}
      {tab === "log" && (
        <div style={s.card}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>📋 Activity log</div>
          {log.length === 0 ? (
            <div style={{ color: "#6b6b8a", fontSize: 13 }}>No actions yet.</div>
          ) : (
            log.map((m, i) => (
              <div key={i} style={{ fontSize: 12, padding: "5px 0", borderBottom: "1px solid #2d2d44", fontFamily: "monospace", color: m.includes("❌") ? "#f87171" : m.includes("✅") ? "#4ade80" : "#a0a0bf" }}>
                {m}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
