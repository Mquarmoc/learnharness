"use client";

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from "react";
import Link from "next/link";
import { useServerEvent, useServerResync } from "@/components/server-events";
import type { ChatListItem } from "@/src/core";

const MobileContext = createContext(false);
export const useMobileCompanion = () => useContext(MobileContext);

export function MobileFrame({ children }: { children: ReactNode }) {
	const [status, setStatus] = useState("Connecting to desktop…");
	useEffect(() => {
		const check = async () => {
			try {
				const res = await fetch("/mobile/status", { cache: "no-store", signal: AbortSignal.timeout(8000) });
				if (res.status === 401) { window.location.assign("/pair"); return; }
				if (!res.ok) throw new Error();
				const body = await res.json();
				setStatus(body.preview ? "Test preview · sample lessons · no AI connected" : "Phone paired. Keep LearnHarness open on the PC.");
			} catch { setStatus("Desktop unavailable. Keep LearnHarness open, then reload."); }
		};
		void check();
		const visible = () => { if (!document.hidden) void check(); };
		document.addEventListener("visibilitychange", visible);
		window.addEventListener("online", check);
		const offline = () => setStatus("Phone is offline. Reconnect to continue.");
		window.addEventListener("offline", offline);
		return () => { document.removeEventListener("visibilitychange", visible); window.removeEventListener("online", check); window.removeEventListener("offline", offline); };
	}, []);
	useEffect(() => {
		const viewport = window.visualViewport;
		const resize = () => document.documentElement.style.setProperty("--lh-mobile-height", `${viewport?.height ?? window.innerHeight}px`);
		resize();
		viewport?.addEventListener("resize", resize);
		return () => { viewport?.removeEventListener("resize", resize); document.documentElement.style.removeProperty("--lh-mobile-height"); };
	}, []);
	return <MobileContext.Provider value={true}>
		<div className="lh-mobile flex min-w-0 flex-1 flex-col" data-testid="mobile-frame">
			<nav className="lh-mobile-nav flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3" aria-label="Phone navigation">
				<Link href="/mobile" className="inline-flex min-h-11 items-center underline underline-offset-4">Sessions</Link>
				<Link href="/" className="inline-flex min-h-11 items-center underline underline-offset-4">Learning map</Link>
				<form method="post" action="/mobile/logout"><button className="min-h-11 px-2">Disconnect phone</button></form>
				<p className="w-full pb-2 text-xs text-muted-foreground" role="status">{status}</p>
			</nav>
			<main className="min-h-0 min-w-0 flex-1">{children}</main>
		</div>
	</MobileContext.Provider>;
}

export function MobileSessions() {
	const [chats, setChats] = useState<ChatListItem[] | null>(null);
	const [error, setError] = useState("");
	const [query, setQuery] = useState("");
	const load = useCallback(async () => {
		setError("");
		try {
			const res = await fetch("/api/chats", { cache: "no-store", signal: AbortSignal.timeout(8000) });
			if (res.status === 401) { window.location.assign("/pair"); return; }
			if (!res.ok) throw new Error();
			const body = await res.json();
			setChats(body.chats);
		} catch { setError("Could not load sessions. Keep the PC awake and LearnHarness open, then try again."); }
	}, []);
	useEffect(() => {
		void load();
		const visible = () => { if (!document.hidden) void load(); };
		document.addEventListener("visibilitychange", visible);
		return () => document.removeEventListener("visibilitychange", visible);
	}, [load]);
	useServerResync(load);
	useServerEvent("chats-changed", load);
	useServerEvent("turn-started", load);
	useServerEvent("turn-settled", load);
	const shown = chats?.filter((chat) => chat.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
	return <section className="h-full overflow-y-auto px-4 py-6">
		<div className="mx-auto max-w-2xl">
			<h1 className="font-title text-3xl">Your learning sessions</h1>
			<p className="my-3 text-muted-foreground">Pick a session to continue. Your answers are saved on the PC.</p>
			<div className="my-4 flex flex-wrap gap-3">
				<Link href="/chat/new" className="inline-flex min-h-11 items-center rounded-lg border border-border px-4">New lesson</Link>
				<Link href="/chat/new?mode=practice" className="inline-flex min-h-11 items-center rounded-lg border border-border px-4">New practice</Link>
			</div>
			<label htmlFor="mobile-search" className="mb-2 block">Find a session</label>
			<input id="mobile-search" value={query} onChange={(event) => setQuery(event.target.value)} className="mb-4 min-h-11 w-full rounded-lg border border-border bg-card px-3 text-base" placeholder="Russian, aviation…" />
			{error && <div role="alert"><p>{error}</p><button className="my-3 min-h-11 rounded-lg border border-border px-4" onClick={() => void load()}>Try again</button></div>}
			{!chats && !error && <p role="status">Loading sessions…</p>}
			{shown?.length === 0 && <p>{query ? "No sessions match. Try another name." : "No sessions yet. Start a new lesson above."}</p>}
			<ul className="space-y-3">{shown?.map((chat) => <li key={chat.id}>
				<Link href={`/chat/${chat.id}`} className="block min-h-11 rounded-lg border border-border bg-card p-4">
					<span className="block break-words font-title text-xl">{chat.title}</span>
					<span className="mt-1 block text-sm text-muted-foreground">{chat.kind === "practice" ? "Practice" : "Lesson"} · {chat.busy ? "Teacher is working" : "Continue learning"}</span>
				</Link>
			</li>)}</ul>
			<p className="mt-6 text-sm text-muted-foreground">For a home screen shortcut, use your browser’s “Add to Home Screen”. The PC and a network connection are required.</p>
		</div>
	</section>;
}
