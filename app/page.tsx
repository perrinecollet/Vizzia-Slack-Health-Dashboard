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

const TABS = ["kpi", "channels", "actions", "log"] as const;
const TAB_LABELS: Record<string, string> = {
  kpi: "📊 KPIs",
  channels: "📢 Channels",
  actions: "🚀 Actions",
  log: "📋 Journal",
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
  const [expandedChan, setExpandedChan] = useState<string | null>(null);

  const addLog = (msg: string) =>
    setLog((l) => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...l]);

  // ── PHASE 1 : channels + membres (rapide) ─────────────────────────────────
  const loadPhase1 = useCallback(async () => {
    setLoading(true);
    setLoadMsg("Récupération des channels...");
    addLog("🔄 Chargement channels + membres...");
    try {
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

      setLoadMsg(`${channels.length} channels. Récupération des membres...`);
      let members: any[] = [], mc = "";
      do {
        const r = await slackApi("users.list", {
          limit: 200,
          ...(mc ? { cursor: mc } : {}),
        });
        members = [
          ...members,
          ...(r.members || []).filter(
            (m: any) => !m.is_bot && !m.deleted && m.id !== "USLACKBOT"
          ),
        ];
        mc = r.response_metadata?.next_cursor || "";
      } while (mc);

      const helpChan = channels.find((c: any) => c.name === "help-slack");
      const withIssues = channels.map((ch: any) => {
        const issues: string[] = [];
        if (!NAMING_PREFIXES.some((p) => ch.name.startsWith(p))) issues.push("naming");
        if (!ch.topic?.value) issues.push("topic");
        if (!ch.purpose?.value) issues.push("description");
        return { ...ch, issues, lastTs: null, dormant: false };
      });

      setData({
        channels: withIssues,
        members,
        nonCompliant: withIssues.filter((c: any) => c.issues.length > 0),
        dormant: [],
        tempDormant: [],
        helpChan,
        pubCount: channels.filter((c: any) => !c.is_private).length,
        withDesc: channels.filter((c: any) => c.purpose?.value).length,
        withTopic: channels.filter((c: any) => c.topic?.value).length,
        total: channels.length,
        statsLoaded: false,
      });
      addLog(`✅ ${channels.length} channels, ${members.length} membres chargés`);
    } catch (e: any) {
      addLog(`❌ Erreur: ${e.message}`);
    }
    setLoading(false);
    setLoadMsg("");
  }, []);

  // ── Chargement auto au démarrage ──────────────────────────────────────────
  useEffect(() => { loadPhase1(); }, [loadPhase1]);

  // ── PHASE 2 : dernière activité par channel (sans filtre oldest) ──────────
  const loadPhase2 = useCallback(async () => {
    if (!data) return;
    setLoading(true);
    addLog("🔄 Chargement dernière activité par channel...");
    const chanStats: Record<string, string | null> = {};

    for (let i = 0; i < data.channels.length; i++) {
      const ch = data.channels[i];
      setLoadMsg(`Activité ${i + 1}/${data.channels.length}...`);
      try {
        // Pas de filtre oldest → vrai dernier message quelle que soit sa date
        const r = await slackApi("conversations.history", {
          channel: ch.id,
          limit: 1,
        });
        chanStats[ch.id] = r.messages?.[0]?.ts || null;
      } catch {
        chanStats[ch.id] = null;
      }
      await new Promise((res) => setTimeout(res, 80));
    }

    const updatedChannels = data.channels.map((ch: any) => ({
      ...ch,
      lastTs: chanStats[ch.id] ?? null,
      // Dormant = dernier message il y a plus de 90j (ou aucun message)
      dormant: daysSince(chanStats[ch.id] ?? null) > 90,
    }));

    setData((prev: any) => ({
      ...prev,
      channels: updatedChannels,
      dormant: updatedChannels.filter(
        (c: any) => c.dormant && !c.name.startsWith("temp-")
      ),
      tempDormant: updatedChannels.filter(
        (c: any) => c.name.startsWith("temp-") && c.dormant
      ),
      statsLoaded: true,
    }));
    addLog(`✅ Activité chargée pour ${data.channels.length} channels`);
    setLoading(false);
    setLoadMsg("");
  }, [data]);

  // ── ACTIONS ADMIN ─────────────────────────────────────────────────────────

  // Notifier un channel individuel (depuis l'onglet Channels)
  const sendNonCompliantOne = async (ch: any) => {
    if (!data?.helpChan) { addLog("❌ #help-slack introuvable"); return; }
    const owner = ch.creator ? `<@${ch.creator}>` : "owner inconnu";
    const issues = ch.issues
      .map((i: string) =>
        i === "naming" ? "❌ Naming" : i === "topic" ? "❌ Topic" : "❌ Description"
      )
      .join(", ");
    await slackApi("chat.postMessage", {
      channel: data.helpChan.id,
      text: `📋 *Channel non conforme* : #${ch.name}\n${owner} merci de corriger : ${issues}`,
    });
    addLog(`✅ Notification envoyée pour #${ch.name}`);
  };

  // Un seul message récap pour tous les non-conformes (depuis Actions)
  const sendNonCompliantAll = async () => {
    if (!data?.helpChan) { addLog("❌ #help-slack introuvable"); return; }
    if (data.nonCompliant.length === 0) { addLog("✅ Aucun channel non conforme"); return; }
    const date = new Date().toLocaleDateString("fr-FR");
    const lines = data.nonCompliant
      .map((c: any) => {
        const owner = c.creator ? `<@${c.creator}>` : "owner inconnu";
        const issues = c.issues
          .map((i: string) =>
            i === "naming" ? "❌ Naming" : i === "topic" ? "❌ Topic" : "❌ Desc"
          )
          .join(", ");
        return `• #${c.name} — ${owner} — ${issues}`;
      })
      .join("\n");
    await slackApi("chat.postMessage", {
      channel: data.helpChan.id,
      text: `📋 *Channels non conformes — récap du ${date}*\n\n${lines}`,
    });
    addLog(`✅ Récap envoyé pour ${data.nonCompliant.length} channels non conformes`);
  };

  // Un seul message récap pour tous les dormants
  const alertDormant = async () => {
    if (!data?.helpChan) { addLog("❌ #help-slack introuvable"); return; }
    if (data.dormant.length === 0) { addLog("✅ Aucun channel dormant"); return; }
    const date = new Date().toLocaleDateString("fr-FR");
    const lines = data.dormant
      .map((c: any) => {
        const owner = c.creator ? `<@${c.creator}>` : "owner inconnu";
        return `• #${c.name} — ${owner} — inactif depuis ${daysSince(c.lastTs)}j`;
      })
      .join("\n");
    await slackApi("chat.postMessage", {
      channel: data.helpChan.id,
      text: `💤 *Channels dormants (+90j) — récap du ${date}*\n\n${lines}\n\nMerci de confirmer si ces channels peuvent être archivés.`,
    });
    addLog(`✅ Récap dormants envoyé pour ${data.dormant.length} channels`);
  };

  const archiveTemp = async () => {
    let count = 0;
    for (const c of data.tempDormant) {
      const r = await slackApi("conversations.archive", { channel: c.id });
      if (r.ok) count++;
    }
    addLog(`✅ ${count} channel(s) temp- archivé(s)`);
    loadPhase1();
  };

  // ── STYLES ────────────────────────────────────────────────────────────────
  const s = {
    wrap: { fontFamily: "Inter,sans-serif", background: "#0f0f1a", minHeight: "100vh", color: "#e2e2f0", padding: "20px" },
    card: { background: "#1a1a2e", borderRadius: 14, padding: "18px 20px", border: "1px solid #2d2d44", marginBottom: 14 },
    btn: (col = "#4f46e5") => ({ background: `linear-gradient(135deg,${col},${col}bb)`, border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", fontWeight: 600, fontSize: 12, cursor: "pointer", marginRight: 6, marginBottom: 4 } as React.CSSProperties),
    badge: (ok: boolean) => ({ display: "inline-block", borderRadius: 5, padding: "2px 7px", fontSize: 10, fontWeight: 700, background: ok ? "#14532d" : "#450a0a", color: ok ? "#4ade80" : "#f87171" } as React.CSSProperties),
    tabBtn: (a: boolean) => ({ padding: "8px 16px", borderRadius: 8, border: "none", background: a ? "#4f46e5" : "transparent", color: a ? "#fff" : "#6b6b8a", fontWeight: 600, fontSize: 12, cursor: "pointer" } as React.CSSProperties),
    kpi: { background: "#1a1a2e", borderRadius: 12, padding: "14px", border: "1px solid #2d2d44", textAlign: "center" } as React.CSSProperties,
    input: { background: "#0f0f1a", border: "1px solid #2d2d44", borderRadius: 9, padding: "10px 14px", color: "#e2e2f0", fontSize: 13 } as React.CSSProperties,
    row: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid #2d2d44", gap: 8, flexWrap: "wrap" } as React.CSSProperties,
    filterBtn: (active: boolean) => ({
      padding: "6px 14px",
      borderRadius: 20,
      border: `1px solid ${active ? "#4f46e5" : "#2d2d44"}`,
      background: active ? "#4f46e5" : "transparent",
      color: active ? "#fff" : "#9ca3af",
      fontWeight: active ? 600 : 400,
      fontSize: 12,
      cursor: "pointer",
      whiteSpace: "nowrap",
    } as React.CSSProperties),
  };

  const FILTERS = [
    { key: "all", label: "Tous" },
    { key: "noncompliant", label: "⚠️ Non conformes" },
    { key: "dormant", label: "💤 Dormants" },
    { key: "temp", label: "🗑️ Temp-" },
    { key: "public", label: "🌐 Publics" },
  ];

  const filteredChannels = (data?.channels || [])
    .filter((c: any) => {
      if (chanFilter === "noncompliant") return c.issues.length > 0;
      if (chanFilter === "dormant") return c.dormant;
      if (chanFilter === "temp") return c.name.startsWith("temp-");
      if (chanFilter === "public") return !c.is_private;
      return true;
    })
    .filter((c: any) => c.name.includes(chanSearch.toLowerCase()));

  return (
    <div style={s.wrap}>
      {/* ── HEADER ── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 20 }}>⚡ Vizzia Slack Health Dashboard</div>
          <div style={{ fontSize: 12, color: "#6b6b8a" }}>
            {email}
            {isAdmin && (
              <span style={{ marginLeft: 8, background: "#1e1b4b", color: "#818cf8", borderRadius: 6, padding: "2px 8px", fontSize: 11 }}>
                ✦ Admin
              </span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={loadPhase1} disabled={loading} style={s.btn("#059669")}>
            {loading && !data ? `⏳ ${loadMsg}` : "🔄 Actualiser"}
          </button>
          {data && !data.statsLoaded && (
            <button onClick={loadPhase2} disabled={loading} style={s.btn("#2563eb")}>
              {loading && data && !data.statsLoaded ? `⏳ ${loadMsg}` : "📊 Charger activité"}
            </button>
          )}
          {data?.statsLoaded && (
            <button onClick={loadPhase2} disabled={loading} style={s.btn("#374151")}>
              {loading ? `⏳ ${loadMsg}` : "↻ Mettre à jour activité"}
            </button>
          )}
          <button onClick={() => signOut({ callbackUrl: "/login" })} style={s.btn("#6b6b8a")}>
            Déconnexion
          </button>
        </div>
      </div>

      {/* ── TABS ── */}
      <div style={{ display: "flex", gap: 4, marginBottom: 18, background: "#1a1a2e", borderRadius: 10, padding: 4, width: "fit-content", flexWrap: "wrap" }}>
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} style={s.tabBtn(tab === t)}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {/* ── CHARGEMENT EN COURS ── */}
      {!data && loading && (
        <div style={{ ...s.card, textAlign: "center", color: "#6b6b8a" }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>⏳</div>
          <div style={{ fontWeight: 600 }}>{loadMsg || "Chargement..."}</div>
        </div>
      )}

      {/* ── BANDEAU ACTIVITÉ NON CHARGÉE ── */}
      {data && !data.statsLoaded && tab !== "log" && (
        <div style={{ background: "#1e1b4b", border: "1px solid #3730a3", borderRadius: 10, padding: "10px 16px", marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <span style={{ fontSize: 13, color: "#a5b4fc" }}>
            ℹ️ Channels et membres chargés. Cliquez sur "Charger activité" pour voir les dormants et la dernière activité par channel.
          </span>
          <button onClick={loadPhase2} disabled={loading} style={s.btn("#4f46e5")}>
            {loading ? `⏳ ${loadMsg}` : "📊 Charger activité"}
          </button>
        </div>
      )}

      {/* ── KPIs ── */}
      {tab === "kpi" && data && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 10, marginBottom: 14 }}>
            {[
              { label: "Total channels", val: data.total, icon: "📢", color: "#818cf8" },
              { label: "Publics", val: data.pubCount, icon: "🌐", color: "#34d399" },
              { label: "Non conformes", val: data.nonCompliant.length, icon: "⚠️", color: "#f87171" },
              { label: "Dormants +90j", val: data.statsLoaded ? data.dormant.length : "—", icon: "💤", color: "#6b6b8a" },
              { label: "Temp- à archiver", val: data.statsLoaded ? data.tempDormant.length : "—", icon: "🗑️", color: "#c084fc" },
              { label: "Avec description", val: `${pct(data.withDesc, data.total)}%`, icon: "📝", color: "#34d399" },
              { label: "Avec topic", val: `${pct(data.withTopic, data.total)}%`, icon: "🏷️", color: "#60a5fa" },
              { label: "Membres", val: data.members.length, icon: "👥", color: "#f472b6" },
            ].map((k) => (
              <div key={k.label} style={s.kpi}>
                <div style={{ fontSize: 20 }}>{k.icon}</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: k.color, margin: "4px 0" }}>{k.val}</div>
                <div style={{ fontSize: 11, color: "#6b6b8a" }}>{k.label}</div>
              </div>
            ))}
          </div>
          <div style={s.card}>
            <div style={{ fontWeight: 700, marginBottom: 10 }}>Compliance channels</div>
            {[
              { label: "Naming conforme", val: pct(data.total - data.nonCompliant.filter((c: any) => c.issues.includes("naming")).length, data.total), color: "#34d399" },
              { label: "Description renseignée", val: pct(data.withDesc, data.total), color: "#60a5fa" },
              { label: "Topic renseigné", val: pct(data.withTopic, data.total), color: "#f59e0b" },
            ].map((k) => (
              <div key={k.label} style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                  <span>{k.label}</span>
                  <span style={{ color: k.color, fontWeight: 700 }}>{k.val}%</span>
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
          {/* Filtres en boutons pills visibles */}
          <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
            {FILTERS.map((f) => {
              const count =
                f.key === "all" ? data.total :
                f.key === "noncompliant" ? data.nonCompliant.length :
                f.key === "dormant" ? data.dormant.length :
                f.key === "temp" ? data.channels.filter((c: any) => c.name.startsWith("temp-")).length :
                data.pubCount;
              return (
                <button
                  key={f.key}
                  onClick={() => setChanFilter(f.key)}
                  style={s.filterBtn(chanFilter === f.key)}
                >
                  {f.label} <span style={{ opacity: 0.7, marginLeft: 4 }}>{count}</span>
                </button>
              );
            })}
          </div>
          {/* Barre de recherche */}
          <div style={{ marginBottom: 12 }}>
            <input
              value={chanSearch}
              onChange={(e) => setChanSearch(e.target.value)}
              placeholder="🔍 Rechercher un channel..."
              style={{ ...s.input, width: "100%", maxWidth: 300 }}
            />
            <span style={{ marginLeft: 12, fontSize: 12, color: "#6b6b8a" }}>{filteredChannels.length} résultats</span>
          </div>
          {/* Liste */}
          <div style={{ maxHeight: 500, overflowY: "auto" }}>
            {filteredChannels.map((c: any) => (
              <div key={c.id}>
                <div
                  onClick={() => setExpandedChan(expandedChan === c.id ? null : c.id)}
                  style={{ ...s.row, cursor: "pointer" }}
                >
                  <div>
                    <span style={{ fontFamily: "monospace", fontSize: 13 }}>#{c.name}</span>
                    <span style={{ marginLeft: 8, fontSize: 11, color: "#6b6b8a" }}>{c.is_private ? "🔒" : "🌐"}</span>
                    {c.dormant && (
                      <span style={{ marginLeft: 6, fontSize: 10, background: "#1c1917", color: "#78716c", borderRadius: 5, padding: "1px 6px" }}>
                        💤 {daysSince(c.lastTs)}j
                      </span>
                    )}
                    {!data.statsLoaded && (
                      <span style={{ marginLeft: 6, fontSize: 10, color: "#4b5563" }}>activité non chargée</span>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {c.issues.length === 0
                      ? <span style={s.badge(true)}>✅ Conforme</span>
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
                      📝 Description : <span style={{ color: c.purpose?.value ? "#e2e2f0" : "#f87171" }}>{c.purpose?.value || "Non renseignée"}</span>
                    </div>
                    <div style={{ color: "#6b6b8a", marginBottom: 4 }}>
                      🏷️ Topic : <span style={{ color: c.topic?.value ? "#e2e2f0" : "#f87171" }}>{c.topic?.value || "Non renseigné"}</span>
                    </div>
                    <div style={{ color: "#6b6b8a", marginBottom: 4 }}>
                      ⏱️ Dernière activité : <span style={{ color: "#e2e2f0" }}>
                        {!data.statsLoaded ? "Non chargée" : c.lastTs ? `il y a ${daysSince(c.lastTs)}j` : "Aucun message"}
                      </span>
                    </div>
                    <div style={{ color: "#6b6b8a", marginBottom: 8 }}>
                      👤 Owner : <span style={{ color: "#818cf8" }}>{c.creator ? `<@${c.creator}>` : "Inconnu"}</span>
                    </div>
                    {isAdmin && c.issues.length > 0 && (
                      <button onClick={() => sendNonCompliantOne(c)} style={s.btn("#dc2626")}>
                        📩 Notifier owner
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
              🔒 Accès réservé aux administrateurs
            </div>
          ) : data ? (
            <>
              <div style={s.card}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>📋 Notifier les channels non conformes</div>
                <div style={{ fontSize: 12, color: "#6b6b8a", marginBottom: 10 }}>
                  Envoie un seul message récapitulatif dans #help-slack listant les {data.nonCompliant.length} channels non conformes avec leur owner et les points à corriger.
                </div>
                <button onClick={sendNonCompliantAll} style={s.btn("#dc2626")}>
                  📩 Envoyer récap ({data.nonCompliant.length})
                </button>
              </div>
              <div style={s.card}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>💤 Alerter owners — channels dormants</div>
                <div style={{ fontSize: 12, color: "#6b6b8a", marginBottom: 10 }}>
                  {data.statsLoaded
                    ? `Envoie un récap dans #help-slack pour les ${data.dormant.length} channels inactifs depuis +90j.`
                    : "⚠️ Chargez l'activité pour voir les dormants"}
                </div>
                <button onClick={alertDormant} disabled={!data.statsLoaded} style={s.btn("#d97706")}>
                  ⚠️ Envoyer récap dormants ({data.statsLoaded ? data.dormant.length : "?"})
                </button>
              </div>
              <div style={s.card}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>🗑️ Archiver les channels temp- inactifs</div>
                <div style={{ fontSize: 12, color: "#6b6b8a", marginBottom: 8 }}>
                  {data.statsLoaded
                    ? `${data.tempDormant.length} channel(s) temp- dormants à archiver`
                    : "⚠️ Chargez l'activité pour voir les temp- dormants"}
                </div>
                <div style={{ maxHeight: 100, overflowY: "auto", marginBottom: 10 }}>
                  {data.statsLoaded && data.tempDormant.map((c: any) => (
                    <div key={c.id} style={{ fontSize: 12, fontFamily: "monospace", padding: "2px 0", borderBottom: "1px solid #2d2d44" }}>
                      #{c.name} <span style={{ color: "#6b6b8a" }}>({daysSince(c.lastTs)}j)</span>
                    </div>
                  ))}
                  {data.statsLoaded && data.tempDormant.length === 0 && (
                    <div style={{ color: "#4ade80", fontSize: 12 }}>✅ Aucun channel temp- à archiver</div>
                  )}
                </div>
                {data.statsLoaded && data.tempDormant.length > 0 && (
                  <button onClick={archiveTemp} style={s.btn("#7c3aed")}>
                    🗑️ Archiver ({data.tempDormant.length})
                  </button>
                )}
              </div>
            </>
          ) : (
            <div style={{ ...s.card, textAlign: "center", color: "#6b6b8a" }}>
              Chargez les données d'abord.
            </div>
          )}
        </div>
      )}

      {/* ── LOG ── */}
      {tab === "log" && (
        <div style={s.card}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>📋 Journal d'activité</div>
          {log.length === 0 ? (
            <div style={{ color: "#6b6b8a", fontSize: 13 }}>Aucune action.</div>
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
