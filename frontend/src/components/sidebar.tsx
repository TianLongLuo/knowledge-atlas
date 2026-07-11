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
import { useState } from "react";
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
  const [mobileOpen, setMobileOpen] = useState(false);

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
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {navItems.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== "/" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
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
      {/* Mobile toggle */}
      <Button
        variant="ghost"
        size="icon"
        className="fixed top-3 left-3 z-50 lg:hidden"
        onClick={() => setMobileOpen(!mobileOpen)}
      >
        {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </Button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed top-0 left-0 h-full w-64 bg-sidebar border-r border-sidebar-border z-40 transition-transform duration-200 lg:translate-x-0 lg:static lg:z-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {sidebarContent}
      </aside>
    </>
  );
}
