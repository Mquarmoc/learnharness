/** Touch equivalent of the dock's wheel forwarding; inner scrollers keep native gestures. */
export function bindDockTouchScroll(root: HTMLElement, transcript: HTMLElement) {
    let point: { x: number; y: number } | null = null;
    const reset = () => { point = null; };
    const start = (event: TouchEvent) => {
        point = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
    };
    const move = (event: TouchEvent) => {
        if (!point || event.touches.length !== 1) { reset(); return; }
        const touch = event.touches[0];
        const deltaY = point.y - touch.clientY;
        const deltaX = point.x - touch.clientX;
        point = { x: touch.clientX, y: touch.clientY };
        if (!deltaY || Math.abs(deltaX) > Math.abs(deltaY)) return;
        for (let node = event.target as HTMLElement | null; node && node !== root; node = node.parentElement) {
            if (node.closest?.('input[type="range"]')) return;
            if (node.scrollHeight - node.clientHeight >= 2 && (deltaY < 0 ? node.scrollTop > 0 : node.scrollTop < node.scrollHeight - node.clientHeight - 0.5)) return;
        }
        event.preventDefault();
        transcript.scrollTop += deltaY;
    };
    root.addEventListener("touchstart", start, { passive: true });
    root.addEventListener("touchmove", move, { passive: false });
    root.addEventListener("touchend", reset);
    root.addEventListener("touchcancel", reset);
    return () => {
        root.removeEventListener("touchstart", start);
        root.removeEventListener("touchmove", move);
        root.removeEventListener("touchend", reset);
        root.removeEventListener("touchcancel", reset);
    };
}