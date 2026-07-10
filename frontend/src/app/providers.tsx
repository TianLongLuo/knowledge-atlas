"use client";

import { AuthProvider } from "@/lib/auth-context";
import { AppLayout } from "@/components/app-layout";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <TooltipProvider>
        <AppLayout>
          {children}
        </AppLayout>
        <Toaster />
      </TooltipProvider>
    </AuthProvider>
  );
}
