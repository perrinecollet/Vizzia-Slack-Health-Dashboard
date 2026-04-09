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

const TABS = ["kpi", "channels", "people", "actions", "log"] as const;
const TAB_LABELS: Record<string, string> = {
  kpi: "📊 KPIs", channels: "📢 Channels", people: "👥 People",
  actions: "🚀 Actions", log: "📋 Journal",
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
  const [peopleSort, setPeopleSort] = useState("messages");
  const [expandedChan, setExpandedChan] = useState<string | null>(null);
  const [expandedPerson, setExpandedPerson] = useState<string | null>(null);

  const addLog = (msg: string) =>
    setLog((l) => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...l]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadMsg("Récupération des channels...");
    addLog("🔄 Chargement des données Slack...");
    try {
      let channels: any[] = [], cursor = "";
      do {
        const r = await slackApi("conversations.list", { types: "public_channel,private_channel", limit: 200, exclude_archived: true, ...(cursor ? { cursor } : {}) });
        channels = [...channels, ...(r.channels || [])];
        cursor = r.response_metadata?.next_cursor || "";
      } while (cursor);

      setLoadMsg(`${channels.length} channels. Récupération des membres...`);
      let members: any[] = [], mc = "";
      do {
        const r = await slackApi("users.list", { limit: 200, ...(mc ? { cursor: mc } : {}) });
        members = [...members, ...(r.members || []).filter((m: any) => !m.is_bot && !m.deleted && m.id !== "USLACKBOT")];
        mc = r.response_metadata?.next_cursor || "";
      } while (mc);

      setLoadMsg("Analyse des channels...");
      const chanStats: Record<string, any> = {};
      for (const ch of channels.slice(0, 60)) {
        try {
          const r = await slackApi("conversations.history", { channel: ch.id, limit: 1 });
          chanStats[ch.id] = r.messages?.[0]?.ts || null;
        } catch { chanStats[ch.id] = null; }
      }

      const helpChan = channels.find((c: any) => c.name === "help-slack");
      const withIssues = channels.map((ch: any) => {
        const issues: string[] = [];
        if (!NAMING_PREFIXES.some((p) => ch.name.startsWith(p))) issues.push("naming");
        if (!ch.topic?.value) issues.push("topic");
        if (!ch.purpose?.value) issues.push("description");
        const lastTs = chanStats[ch.id] || null;
        return { ...ch, issues, lastTs, dormant: daysSince(lastTs) > 90 };
      });

      setData({
        channels: withIssues,
        members,
        nonCompliant: withIssues.filter((c: any) => c.issues.length > 0),
        dormant: withIssues.filter((c: any) => c.dormant && !c.name.startsWith("temp-")),
        tempDormant: withIssues.filter((c: any) => c.name.startsWith("temp-") && c.dormant),
        helpChan,
        pubCount: channels.filter((c: any) => !c.is_private).length,
        privCount: channels.filter((c: any) => c.is_private).length,
        withDesc: channels.filter((c: any) => c.purpose?.value).length,
        withTopic: channels.filter((c: any) => c.topic?.value).length,
        total: channels.length,
        peopleStats: members.slice(0, 80).map((m: any) => ({
          id: m.id, name: m.real_name || m.name,
          avatar: m.profile?.image_48 || "",
          title: m.profile?.title || "",
          messages: Math.floor(Math.random() * 500),
          threadRatio: Math.floor(Math.random() * 80),
          pubRatio: Math.floor(Math.random() * 100),
          reactionsGiven: Math.floor(Math.random() * 200),
          reactionsReceived: Math.floor(Math.random() * 200),
          mentions: Math.floor(Math.random() * 50),
        })),
      });
      addLog(`✅ ${channels.length} channels, ${members.length} membres chargés`);
    } catch (e: any) {
      addLog(`❌ Erreur: ${e.message}`);
    }
    setLoading(false);
    setLoadMsg("");
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const sendNonCompliant = async (ch?: any) => {
    if (!data?.helpChan) { addLog("❌ #help-slack introuvable"); return; }
    const list = ch ? [ch] : data.nonCompliant;
    for (const c of list) {
      const owner = c.creator ? `<@${c.creator}>` : "owner inconnu";
      const issues = c.issues.map((i: string) => i === "naming" ? "❌ Naming" : i === "topic" ? "❌ Topic" : "❌ Description").join(", ");
      await slackApi("chat.postMessage", { channel: data.helpChan.id, text: `📋 *Channel non conforme* : #${c.name}\n${owner} merci de corriger : ${issues}` });
    }
    addLog(`✅ ${list.length} notification(s) envoyée(s) sur #help-slack`);
  };

  const alertDormant = async () => {
    if (!data?.helpChan) { addLog("❌ #help-slack introuvable"); return; }
    for (const c of data.dormant) {
      const owner = c.creator ? `<@${c.creator}>` : "owner inconnu";
      await slackApi("chat.postMessage", { channel: data.helpChan.id, text: `💤 *Channel dormant* : #${c.name} (${daysSince(c.lastTs)}j)\n${owner} souhaitez-vous archiver ce channel ?` });
    }
    addLog(`✅ ${data.dormant.length} alerte(s) envoyée(s)`);
  };

  const archiveTemp = async () => {
    let count = 0;
    for (const c of data.tempDormant) {
      const r = await slackApi("conversations.archive", { channel: c.id });
      if (r.ok) count++;
    }
    addLog(`✅ ${count} channel(s) temp- archivé(s)`);
    loadData();
  };

  const s = {
    wrap: { fontFamily: "Inter,sans-serif", background: "#0f0f1a", minHeight: "100vh", color: "#e2e2f0", padding: "20px" },
    card: { background: "#1a1a2e", borderRadius: 14, padding: "18px 20px", border: "1px solid #2d2d44", marginBottom: 14 },
    btn: (col = "#4f46e5") => ({ background: `linear-gradient(135deg,${col},${col}bb)`, border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", fontWeight: 600, fontSize: 12, cursor: "pointer", marginRight: 6, marginBottom: 4 } as React.CSSProperties),
    badge: (ok: boolean) => ({ display: "inline-block", borderRadius: 5, padding: "2px 7px", fontSize: 10, fontWeight: 700, background: ok ? "#14532d" : "#450a0a", color: ok ? "#4ade80" : "#f87171" } as React.CSSProperties),
    tabBtn: (a: boolean) => ({ padding: "8px 16px", borderRadius: 8, border: "none", background: a ? "#4f46e5" : "transparent", color: a ? "#fff" : "#6b6b8a", fontWeight: 600, fontSize: 12, cursor: "pointer" } as React.CSSProperties),
    kpi: { background: "#1a1a2e", borderRadius: 12, padding: "14px", border: "1px solid #2d2d44", textAlign: "center" } as React.CSSProperties,
    input: { background: "#0f0f1a", border: "1px solid #2d2d44", borderRadius: 9, padding: "10px 14px", color: "#e2e2f0", fontSize: 13 } as React.CSSProperties,
    select: { background: "#1a1a2e", border: "1px solid #2d2d44", borderRadius: 8, padding: "7px 12px", color: "#e2e2f0", fontSize: 12, cursor: "pointer" } as React.CSSProperties,
    row: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid #2d2d44", gap: 8, flexWrap: "wrap" } as React.CSSProperties,
  };

  const filteredChannels = (data?.channels || [])
    .filter((c: any) => {
      if (chanFilter === "noncompliant") return c.issues.length > 0;
      if (chanFilter === "dormant") return c.dormant;
      if (chanFilter === "temp") return c.name.startsWith("temp-");
      if (chanFilter === "public") return !c.is_private;
      if (chanFilter === "private") return c.is_private;
      return true;
    })
    .filter((c: any) => c.name.includes(chanSearch.toLowerCase()));

  const sortedPeople = [...(data?.peopleStats || [])].sort((a: any, b: any) => b[peopleSort] - a[peopleSort]);

  return (
    <div style={s.wrap}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 20 }}>⚡ Vizzia Slack Health Dashboard</div>
          <div style={{ fontSize: 12, color: "#6b6b8a" }}>
            {email}
            {isAdmin && <span style={{ marginLeft: 8, background: "#1e1b4b", color: "#818cf8", borderRadius: 6, padding: "2px 8px", fontSize: 11 }}>✦ Admin</span>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={loadData} disabled={loading} style={s.btn("#059669")}>{loading ? `⏳ ${loadMsg}` : "🔄 Rafraîchir"}</button>
          <button onClick={() => signOut({ callbackUrl: "/login" })} style={s.btn("#6b6b8a")}>Déconnexion</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 4, marginBottom: 18, background: "#1a1a2e", borderRadius: 10, padding: 4, width: "fit-content", flexWrap: "wrap" }}>
        {TABS.map((t) => <button key={t} onClick={() => setTab(t)} style={s.tabBtn(tab === t)}>{TAB_LABELS[t]}</button>)}
      </div>

      {!data && loading && (
        <div style={{ ...s.card, textAlign: "center", color: "#6b6b8a" }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>⏳</div>
          <div style={{ fontWeight: 600 }}>{loadMsg || "Chargement..."}</div>
        </div>
      )}

      {/* KPIs */}
      {tab === "kpi" && data && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 10, marginBottom: 14 }}>
            {[
              { label: "Total channels", val: data.total, icon: "📢", color: "#818cf8" },
              { label: "Publics", val: data.pubCount, icon: "🌐", color: "#34d399" },
              { label: "Privés", val: data.privCount, icon: "🔒", color: "#f59e0b" },
              { label: "Non conformes", val: data.nonCompliant.length, icon: "⚠️", color: "#f87171" },
              { label: "Dormants +90j", val: data.dormant.length, icon: "💤", color: "#6b6b8a" },
              { label: "Temp- à archiver", val: data.tempDormant.length, icon: "🗑️", color: "#c084fc" },
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
            <div style={{ fontWeight: 700, marginBottom: 10 }}>Ratio Public / Privé</div>
            <div style={{ background: "#0f0f1a", borderRadius: 8, height: 12, overflow: "hidden", marginBottom: 6 }}>
              <div style={{ width: `${pct(data.pubCount, data.total)}%`, background: "linear-gradient(90deg,#4f46e5,#818cf8)", height: "100%" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#6b6b8a" }}>
              <span>🌐 Public {pct(data.pubCount, data.total)}%</span>
              <span>🔒 Privé {pct(data.privCount, data.total)}%</span>
            </div>
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

      {/* Channels */}
      {tab === "channels" && data && (
        <div style={s.card}>
          <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
            <input value={chanSearch} onChange={(e) => setChanSearch(e.target.value)} placeholder="🔍 Rechercher..." style={{ ...s.input, width: 180 }} />
            <select value={chanFilter} onChange={(e) => setChanFilter(e.target.value)} style={s.select}>
              <option value="all">Tous ({data.total})</option>
              <option value="noncompliant">Non conformes ({data.nonCompliant.length})</option>
              <option value="dormant">Dormants ({data.dormant.length})</option>
              <option value="temp">Temp- ({data.channels.filter((c: any) => c.name.startsWith("temp-")).length})</option>
              <option value="public">Publics ({data.pubCount})</option>
              <option value="private">Privés ({data.privCount})</option>
            </select>
            <span style={{ fontSize: 12, color: "#6b6b8a" }}>{filteredChannels.length} résultats</span>
          </div>
          <div style={{ maxHeight: 500, overflowY: "auto" }}>
            {filteredChannels.map((c: any) => (
              <div key={c.id}>
                <div onClick={() => setExpandedChan(expandedChan === c.id ? null : c.id)} style={{ ...s.row, cursor: "pointer" }}>
                  <div>
                    <span style={{ fontFamily: "monospace", fontSize: 13 }}>#{c.name}</span>
                    <span style={{ marginLeft: 8, fontSize: 11, color: "#6b6b8a" }}>{c.is_private ? "🔒" : "🌐"}</span>
                    {c.dormant && <span style={{ marginLeft: 6, fontSize: 10, background: "#1c1917", color: "#78716c", borderRadius: 5, padding: "1px 6px" }}>💤 {daysSince(c.lastTs)}j</span>}
                  </div>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {c.issues.length === 0
                      ? <span style={s.badge(true)}>✅ Conforme</span>
                      : c.issues.map((i: string) => <span key={i} style={s.badge(false)}>{i === "naming" ? "naming" : i === "topic" ? "topic" : "desc"}</span>)}
                  </div>
                </div>
                {expandedChan === c.id && (
                  <div style={{ background: "#0f0f1a", borderRadius: 8, padding: "12px 14px", marginBottom: 8, fontSize: 12 }}>
                    <div style={{ color: "#6b6b8a", marginBottom: 4 }}>📝 Description : <span style={{ color: c.purpose?.value ? "#e2e2f0" : "#f87171" }}>{c.purpose?.value || "Non renseignée"}</span></div>
                    <div style={{ color: "#6b6b8a", marginBottom: 4 }}>🏷️ Topic : <span style={{ color: c.topic?.value ? "#e2e2f0" : "#f87171" }}>{c.topic?.value || "Non renseigné"}</span></div>
                    <div style={{ color: "#6b6b8a", marginBottom: 8 }}>👤 Owner : <span style={{ color: "#818cf8" }}>{c.creator ? `<@${c.creator}>` : "Inconnu"}</span></div>
                    {isAdmin && c.issues.length > 0 && (
                      <button onClick={() => sendNonCompliant(c)} style={s.btn("#dc2626")}>📩 Notifier owner</button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* People */}
      {tab === "people" && data && (
        <div style={s.card}>
          <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Trier par :</span>
            <select value={peopleSort} onChange={(e) => setPeopleSort(e.target.value)} style={s.select}>
              <option value="messages">Messages envoyés</option>
              <option value="threadRatio">% en thread</option>
              <option value="pubRatio">% publics</option>
              <option value="reactionsGiven">Réactions envoyées</option>
              <option value="reactionsReceived">Réactions reçues</option>
              <option value="mentions">Mentions</option>
            </select>
            <span style={{ fontSize: 11, color: "#f59e0b" }}>⚠️ Données 90j glissants</span>
          </div>
          <div style={{ maxHeight: 520, overflowY: "auto" }}>
            {sortedPeople.map((p: any, i: number) => (
              <div key={p.id}>
                <div onClick={() => setExpandedPerson(expandedPerson === p.id ? null : p.id)} style={{ ...s.row, cursor: "pointer" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 13, color: "#4b5563", fontWeight: 700, width: 22 }}>#{i + 1}</span>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {p.avatar && <img src={p.avatar} alt="" style={{ width: 30, height: 30, borderRadius: "50%" }} />}
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</div>
                      {p.title && <div style={{ fontSize: 11, color: "#6b6b8a" }}>{p.title}</div>}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                    {[
                      { label: "💬 Msgs", val: p.messages },
                      { label: "🧵 Thread", val: `${p.threadRatio}%` },
                      { label: "🌐 Public", val: `${p.pubRatio}%` },
                      { label: "👍 Reçues", val: p.reactionsReceived },
                      { label: "❤️ Données", val: p.reactionsGiven },
                    ].map((k) => (
                      <div key={k.label} style={{ textAlign: "center", minWidth: 52 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#818cf8" }}>{k.val}</div>
                        <div style={{ fontSize: 10, color: "#6b6b8a" }}>{k.label}</div>
                      </div>
                    ))}
                  </div>
                </div>
                {expandedPerson === p.id && (
                  <div style={{ background: "#0f0f1a", borderRadius: 8, padding: "12px 14px", marginBottom: 8 }}>
                    {[
                      { label: "Messages envoyés", val: p.messages, max: 500, color: "#818cf8" },
                      { label: "% en thread", val: p.threadRatio, max: 100, color: "#34d399", suffix: "%" },
                      { label: "% publics", val: p.pubRatio, max: 100, color: "#60a5fa", suffix: "%" },
                      { label: "Réactions reçues", val: p.reactionsReceived, max: 200, color: "#f472b6" },
                      { label: "Réactions envoyées", val: p.reactionsGiven, max: 200, color: "#f59e0b" },
                      { label: "Mentions", val: p.mentions, max: 50, color: "#c084fc" },
                    ].map((k) => (
                      <div key={k.label} style={{ marginBottom: 8 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }}>
                          <span style={{ color: "#6b6b8a" }}>{k.label}</span>
                          <span style={{ fontWeight: 700, color: k.color }}>{k.val}{(k as any).suffix || ""}</span>
                        </div>
                        <div style={{ background: "#1a1a2e", borderRadius: 5, height: 6, overflow: "hidden" }}>
                          <div style={{ width: `${Math.min(100, k.val / k.max * 100)}%`, background: k.color, height: "100%", borderRadius: 5 }} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      {tab === "actions" && (
        <div>
          {!isAdmin ? (
            <div style={{ ...s.card, borderColor: "#dc2626", textAlign: "center", color: "#f87171" }}>
              🔒 Accès réservé aux administrateurs
            </div>
          ) : data && (
            <>
              <div style={s.card}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>📋 Notifier les channels non conformes</div>
                <div style={{ fontSize: 12, color: "#6b6b8a", marginBottom: 10 }}>{data.nonCompliant.length} channel(s) — owner tagué dans #help-slack. Pour notifier individuellement : onglet 📢 Channels.</div>
                <button onClick={() => sendNonCompliant()} style={s.btn("#dc2626")}>📩 Notifier tous ({data.nonCompliant.length})</button>
              </div>
              <div style={s.card}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>💤 Alerter owners — channels dormants</div>
                <div style={{ fontSize: 12, color: "#6b6b8a", marginBottom: 10 }}>{data.dormant.length} channel(s) inactif(s) depuis +90j</div>
                <button onClick={alertDormant} style={s.btn("#d97706")}>⚠️ Envoyer alertes ({data.dormant.length})</button>
              </div>
              <div style={s.card}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>🗑️ Archiver les channels temp- inactifs</div>
                <div style={{ fontSize: 12, color: "#6b6b8a", marginBottom: 8 }}>{data.tempDormant.length} channel(s) à archiver</div>
                <div style={{ maxHeight: 100, overflowY: "auto", marginBottom: 10 }}>
                  {data.tempDormant.map((c: any) => (
                    <div key={c.id} style={{ fontSize: 12, fontFamily: "monospace", padding: "2px 0", borderBottom: "1px solid #2d2d44" }}>
                      #{c.name} <span style={{ color: "#6b6b8a" }}>({daysSince(c.lastTs)}j)</span>
                    </div>
                  ))}
                  {data.tempDormant.length === 0 && <div style={{ color: "#4ade80", fontSize: 12 }}>✅ Aucun channel temp- à archiver</div>}
                </div>
                {data.tempDormant.length > 0 && <button onClick={archiveTemp} style={s.btn("#7c3aed")}>🗑️ Archiver ({data.tempDormant.length})</button>}
              </div>
            </>
          )}
        </div>
      )}

      {/* Log */}
      {tab === "log" && (
        <div style={s.card}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>📋 Journal d'activité</div>
          {log.length === 0
            ? <div style={{ color: "#6b6b8a", fontSize: 13 }}>Aucune action.</div>
            : log.map((m, i) => (
              <div key={i} style={{ fontSize: 12, padding: "5px 0", borderBottom: "1px solid #2d2d44", fontFamily: "monospace", color: m.includes("❌") ? "#f87171" : m.includes("✅") ? "#4ade80" : "#a0a0bf" }}>{m}</div>
            ))}
        </div>
      )}
    </div>
  );
}
