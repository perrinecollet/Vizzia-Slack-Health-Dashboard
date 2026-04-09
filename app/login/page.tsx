"use client";
import { useState, Suspense } from "react";
import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";

function LoginForm() {
  const [loading, setLoading] = useState(false);
  const params = useSearchParams();
  const error = params.get("error");

  return (
    <div style={{ background: "#1a1a2e", border: "1px solid #2d2d44", borderRadius: 16, padding: "40px 36px", width: 360, textAlign: "center" }}>
      <div style={{ fontSize: 36, marginBottom: 12 }}>⚡</div>
      <h1 style={{ color: "#e2e2f0", fontSize: 20, fontWeight: 800, margin: "0 0 6px" }}>
        Vizzia Slack Health Dashboard
      </h1>
      <p style={{ color: "#6b6b8a", fontSize: 13, marginBottom: 28 }}>
        Connectez-vous avec votre compte Vizzia
      </p>

      {error === "AccessDenied" && (
        <div style={{ background: "#450a0a", color: "#f87171", borderRadius: 8, padding: "10px 14px", fontSize: 13, marginBottom: 20 }}>
          ❌ Accès refusé — compte @vizzia.fr requis
        </div>
      )}

      <button
        onClick={async () => { setLoading(true); await signIn("google", { callbackUrl: "/" }); }}
        disabled={loading}
        style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, width: "100%", padding: "12px", background: "#fff", border: "none", borderRadius: 9, fontSize: 14, fontWeight: 600, color: "#1a1a1a", cursor: "pointer" }}
      >
        <img src="https://www.google.com/favicon.ico" width={18} height={18} alt="Google" />
        {loading ? "Connexion..." : "Se connecter avec Google"}
      </button>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh", background: "#0f0f1a", fontFamily: "Inter,sans-serif" }}>
      <Suspense fallback={<div style={{ color: "#6b6b8a" }}>Chargement...</div>}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
