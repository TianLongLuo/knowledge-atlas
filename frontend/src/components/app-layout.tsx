"use client";

import { useAuth } from "@/lib/auth-context";
import { Sidebar } from "@/components/sidebar";
import { CyberScrollIndicator } from "@/components/cyber-scroll-indicator";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { Loader2 } from "lucide-react";

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  const isLoginPage = pathname === "/login";

  useEffect(() => {
    if (!isLoading && !isAuthenticated && !isLoginPage) {
      router.push("/login");
    }
    if (!isLoading && isAuthenticated && isLoginPage) {
      router.push("/");
    }
  }, [isLoading, isAuthenticated, isLoginPage, router]);

  // Login page doesn't get sidebar
  if (isLoginPage) {
    if (isLoading) {
      return (
        <div className="flex items-center justify-center min-h-screen">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      );
    }
    return <>{children}</>;
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return null; // Will redirect
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <CyberScrollIndicator />
      {/* Full-width content — sidebar overlays, no permanent reservation */}
      <main className="cyber-scrollbar flex-1 w-full overflow-y-auto p-4 md:p-6 lg:p-8">
        {children}
      </main>
    </div>
  );
}
