"use client";

import { AuthProvider } from "@/lib/auth-context";
import { AppLayout } from "@/components/app-layout";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { useEffect, useRef } from "react";

function SSEProvider({ children }: { children: React.ReactNode }) {
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    // Subscribe to SSE stream for real-time updates
    const es = new EventSource("/api/notes/stream", { withCredentials: true });
    eventSourceRef.current = es;

    es.addEventListener("note_created", () => {
      // Refresh would be handled by React Query or context
      // For now, dispatch custom events that pages can listen to
      window.dispatchEvent(new CustomEvent("atlas:note-created"));
    });

    es.addEventListener("note_updated", () => {
      window.dispatchEvent(new CustomEvent("atlas:note-updated"));
    });

    es.addEventListener("note_deleted", () => {
      window.dispatchEvent(new CustomEvent("atlas:note-deleted"));
    });

    es.addEventListener("sync_start", () => {
      window.dispatchEvent(new CustomEvent("atlas:sync-start"));
    });

    es.addEventListener("sync_complete", () => {
      window.dispatchEvent(new CustomEvent("atlas:sync-complete"));
    });

    es.addEventListener("sync_failure", (event: MessageEvent) => {
      window.dispatchEvent(new CustomEvent("atlas:sync-failure", { detail: event.data }));
    });

    es.onerror = () => {
      // EventSource auto-reconnects; just log
      console.debug("SSE connection interrupted, will reconnect");
    };

    return () => {
      es.close();
    };
  }, []);

  return <>{children}</>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <TooltipProvider>
        <SSEProvider>
          <AppLayout>
            {children}
          </AppLayout>
          <Toaster />
        </SSEProvider>
      </TooltipProvider>
    </AuthProvider>
  );
}
