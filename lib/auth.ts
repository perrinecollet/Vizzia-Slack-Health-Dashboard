import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN || "vizzia.fr";
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase());

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  pages: {
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    async signIn({ profile }) {
      const email = profile?.email?.toLowerCase();
      if (!email) return false;
      // Seuls les emails @vizzia.fr sont autorisés
      return email.endsWith(`@${ALLOWED_DOMAIN}`);
    },
    async session({ session }) {
      if (session.user?.email) {
        // On ajoute isAdmin dans la session
        (session.user as any).isAdmin = ADMIN_EMAILS.includes(
          session.user.email.toLowerCase()
        );
      }
      return session;
    },
    async authorized({ auth: session, request }) {
      const { pathname } = request.nextUrl;
      if (
        pathname.startsWith("/login") ||
        pathname.startsWith("/api/auth")
      ) return true;
      return !!session?.user;
    },
  },
});
