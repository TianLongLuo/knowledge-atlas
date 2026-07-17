"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import {
  LayoutDashboard,
  FileText,
  Search,
  Bot,
  RefreshCw,
  LogOut,
  Menu,
  X,
  BookOpen,
  Share2,
} from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/documents", label: "Documents", icon: FileText },
  { href: "/search", label: "Search", icon: Search },
  { href: "/graph", label: "Knowledge Map", icon: Share2 },
  { href: "/agent", label: "AI Assistant", icon: Bot },
  { href: "/sync", label: "Sync", icon: RefreshCw },
];

export function Sidebar() {
  const pathname = usePathname();
  const { logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);

  const showSidebar = open || hovered;

  const startCloseTimer = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      setHovered(false);
    }, 300);
  }, []);

  const cancelCloseTimer = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  // Keyboard: Escape closes
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setHovered(false);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  // Focus trap handling: close on outside focus
  useEffect(() => {
    if (!sidebarRef.current || !showSidebar) return;
    const handler = (e: FocusEvent) => {
      if (sidebarRef.current && !sidebarRef.current.contains(e.target as Node)) {
        setHovered(false);
      }
    };
    document.addEventListener("focusin", handler);
    return () => document.removeEventListener("focusin", handler);
  }, [showSidebar]);

  // Don't show sidebar on login page
  if (pathname === "/login") return null;

  const sidebarContent = (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="flex items-center gap-2 px-4 py-5 border-b border-sidebar-border">
        <BookOpen className="h-6 w-6 text-primary" />
        <span className="font-semibold text-lg text-sidebar-foreground">
          Knowledge Atlas
        </span>
      </div>

      {/* Nav items */}
      <nav className="cyber-scrollbar flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {navItems.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== "/" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => { setOpen(false); setHovered(false); }}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                  : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
              )}
            >
              <item.icon className="h-5 w-5 shrink-0" />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Logout */}
      <div className="p-3 border-t border-sidebar-border">
        <button
          onClick={logout}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 transition-colors w-full"
        >
          <LogOut className="h-5 w-5 shrink-0" />
          <span>Sign out</span>
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Left-edge hot zone (desktop only) — invisible trigger strip */}
      <div
        className="hidden lg:block fixed left-0 top-0 h-full z-30"
        style={{ width: "8px" }}
        onMouseEnter={() => setHovered(true)}
      />

      {/* Keyboard-accessible toggle button (visible on focus) */}
      <button
        className="fixed top-3 left-3 z-50 opacity-0 focus:opacity-100 lg:opacity-0 transition-opacity rounded-md p-2 bg-sidebar border border-sidebar-border"
        onClick={() => { setOpen(true); setHovered(true); }}
        onFocus={() => setHovered(true)}
        aria-label="Open navigation"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Mobile toggle */}
      <Button
        variant="ghost"
        size="icon"
        className="fixed top-3 left-3 z-50 lg:hidden"
        onClick={() => setOpen(!open)}
      >
        {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </Button>

      {/* Mobile overlay */}
      {open && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Overlay sidebar */}
      <aside
        ref={sidebarRef}
        className={cn(
          "fixed top-0 left-0 h-full w-64 bg-sidebar border-r border-sidebar-border z-50 transition-transform duration-200 shadow-xl",
          showSidebar ? "translate-x-0" : "-translate-x-full"
        )}
        onMouseEnter={() => { setHovered(true); cancelCloseTimer(); }}
        onMouseLeave={startCloseTimer}
        onFocus={() => { setHovered(true); cancelCloseTimer(); }}
      >
        {sidebarContent}
      </aside>
    </>
  );
}
