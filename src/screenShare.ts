import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  Device,
  IceCandidate,
  RtcSignalData,
  ScreenState,
  ServerToClientEvents,
} from "../shared/types";
import {
  CandidateQueue,
  RTC_CONFIG,
  VIEWER_CONNECT_TIMEOUT_MS,
  awaitAck,
  canShareScreen,
  isPickerCancel,
} from "./rtc";
import { messageForScreenJoin, messageForScreenStart } from "./messages";

/**
 * Screen sharing over WebRTC (see the flow comment in shared/types.ts).
 *
 * All mutable WebRTC state (streams, peer connections, queued candidates)
 * lives in a plain controller object, not React state: peers and their async
 * negotiation steps outlive renders, and every await has to re-check that its
 * peer is still the current one. The controller publishes an immutable
 * Snapshot for rendering. One controller exists per socket-lifecycle effect
 * run, so a StrictMode/HMR remount disposes the old one (listeners, peers,
 * tracks, timers) and any of its in-flight async work bails on `disposed`.
 */

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export type ViewerStatus =
  /** screen:join sent, awaiting the ack; the overlay isn't open yet. */
  | "joining"
  /** Joined; waiting for the offer / ICE to connect. */
  | "connecting"
  | "connected"
  /** ICE failed or timed out — the overlay offers Retry. */
  | "failed";

export interface ViewerSnapshot {
  sharer: Device;
  status: ViewerStatus;
  stream: MediaStream | null;
}

export interface ScreenToast {
  kind: "error" | "info";
  text: string;
  /** Changes on every new toast so the auto-dismiss timer restarts. */
  id: number;
}

export interface ScreenSnapshot {
  /** Server-authoritative share state (who's sharing, how many watch). */
  screen: ScreenState;
  /** Our own share: "starting" covers the picker + awaiting the ack. */
  sharing: "starting" | "live" | null;
  /** While sharing: socket ids of joined viewers, in join order. Without a
   *  passcode anyone on the LAN can watch, so the sharer is shown who. */
  viewerIds: string[];
  /** Our viewing session, or null when not watching. */
  viewer: ViewerSnapshot | null;
  toast: ScreenToast | null;
}

const NO_SHARE: ScreenState = { sharer: null, viewers: 0 };
const INITIAL: ScreenSnapshot = {
  screen: NO_SHARE,
  sharing: null,
  viewerIds: [],
  viewer: null,
  toast: null,
};

interface SharerPeer {
  pc: RTCPeerConnection;
  queue: CandidateQueue;
}

interface ShareSession {
  stream: MediaStream;
  /** One peer per viewer socket id. */
  peers: Map<string, SharerPeer>;
  /** Joined viewers per the server (a peer may be gone after an error while
   *  the viewer is still joined, so this is tracked separately). */
  viewers: Set<string>;
  /** screen:start has been emitted, so teardown must emit screen:stop. */
  started: boolean;
  /** The server acked screen:start. */
  live: boolean;
  closed: boolean;
}

interface ViewSession {
  sharer: Device;
  /** Only rtc:signal from this id is accepted. */
  sharerId: string;
  status: ViewerStatus;
  pc: RTCPeerConnection | null;
  stream: MediaStream | null;
  queue: CandidateQueue;
  timer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

/** Structural check on relayed signaling: it comes from another client, so
 *  the shape isn't guaranteed even though the server relays only objects. */
function isSignal(data: unknown): data is RtcSignalData {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  if (d.type === "offer" || d.type === "answer") {
    return typeof d.sdp === "string";
  }
  if (d.type === "candidate") {
    return (
      d.candidate === null ||
      (typeof d.candidate === "object" && d.candidate !== undefined)
    );
  }
  return false;
}

/** Add a remote candidate; `null` signals end-of-candidates. Failures (a
 *  stale candidate, older Safari rejecting the end marker) are harmless. */
function addCandidate(pc: RTCPeerConnection, c: IceCandidate | null): void {
  pc.addIceCandidate(c ?? undefined).catch(() => {});
}

/** Screen text should stay sharp: under congestion, drop frame rate rather
 *  than resolution. Not supported everywhere, hence best-effort. */
async function preferResolution(pc: RTCPeerConnection): Promise<void> {
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== "video") continue;
    try {
      const params = sender.getParameters();
      params.degradationPreference = "maintain-resolution";
      await sender.setParameters(params);
    } catch {
      // Unsupported (Firefox, some Safari versions) — keep the default.
    }
  }
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.onended = null;
    track.stop();
  }
}

class ScreenShareController {
  private readonly socket: AppSocket;
  private readonly onChange: (snap: ScreenSnapshot) => void;
  private screen: ScreenState = NO_SHARE;
  private share: ShareSession | null = null;
  private starting = false;
  private view: ViewSession | null = null;
  private toast: ScreenToast | null = null;
  private toastSeq = 0;
  private disposed = false;

  constructor(socket: AppSocket, onChange: (snap: ScreenSnapshot) => void) {
    this.socket = socket;
    this.onChange = onChange;
  }

  /* ---------------------------------------------------------------- */
  /* lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  /** Register socket listeners. Must run before socket.connect(): the server
   *  sends screen:state immediately on connection. */
  attach(): void {
    this.socket.on("screen:state", this.onState);
    this.socket.on("screen:viewer-joined", this.onViewerJoined);
    this.socket.on("screen:viewer-left", this.onViewerLeft);
    this.socket.on("rtc:signal", this.onSignal);
    this.socket.on("disconnect", this.onDisconnect);
  }

  dispose(): void {
    this.socket.off("screen:state", this.onState);
    this.socket.off("screen:viewer-joined", this.onViewerJoined);
    this.socket.off("screen:viewer-left", this.onViewerLeft);
    this.socket.off("rtc:signal", this.onSignal);
    this.socket.off("disconnect", this.onDisconnect);
    // Tear down before flagging disposed so stop/leave still reach the
    // server if the socket is up (a real unmount; StrictMode's fake unmount
    // happens before anything could be active).
    this.teardownShare(true);
    this.teardownView(true);
    this.disposed = true;
  }

  private publish(): void {
    if (this.disposed) return;
    const v = this.view;
    this.onChange({
      screen: this.screen,
      sharing: this.share?.live
        ? "live"
        : this.starting || this.share
          ? "starting"
          : null,
      viewerIds: this.share ? [...this.share.viewers] : [],
      viewer: v
        ? { sharer: v.sharer, status: v.status, stream: v.stream }
        : null,
      toast: this.toast,
    });
  }

  private notify(kind: ScreenToast["kind"], text: string): void {
    this.toast = { kind, text, id: ++this.toastSeq };
    this.publish();
  }

  dismissToast(id: number): void {
    if (this.toast?.id !== id) return;
    this.toast = null;
    this.publish();
  }

  /** Emit only while connected: socket.io buffers emits made while offline
   *  and replays them on reconnect, when they'd refer to a dead session. */
  private emitIfConnected(fn: () => void): void {
    if (this.socket.connected) fn();
  }

  private signal(to: string, data: RtcSignalData): void {
    if (this.disposed) return;
    this.emitIfConnected(() => this.socket.emit("rtc:signal", { to, data }));
  }

  /* ---------------------------------------------------------------- */
  /* server events                                                     */
  /* ---------------------------------------------------------------- */

  private onState = (state: ScreenState): void => {
    this.screen = state;
    // The share we're watching ended or changed hands.
    const v = this.view;
    if (v && (!state.sharer || state.sharer.id !== v.sharerId)) {
      this.teardownView(false);
      this.toast = { kind: "info", text: "Sharing ended", id: ++this.toastSeq };
    }
    // The server no longer has us as sharer (only meaningful once acked —
    // a state broadcast from before our start may still be in flight).
    const s = this.share;
    if (s?.live && state.sharer?.id !== this.socket.id) {
      this.teardownShare(false);
      this.toast = {
        kind: "error",
        text: "Screen sharing was stopped by the server.",
        id: ++this.toastSeq,
      };
    }
    this.publish();
  };

  private onDisconnect = (): void => {
    // The server ends a share (and drops viewers) when their socket goes, so
    // local sessions are dead. Deliberately no auto-restart on reconnect:
    // re-sharing the screen must be the user's explicit choice.
    // (A picker still open is left alone: if the user completes it, startShare
    // re-checks the connection before announcing anything.)
    if (this.share) {
      this.teardownShare(false);
      this.toast = {
        kind: "error",
        text: "Screen sharing stopped — lost connection to the server.",
        id: ++this.toastSeq,
      };
    }
    if (this.view) {
      this.teardownView(false);
      this.toast = {
        kind: "info",
        text: "Lost connection — the screen share closed.",
        id: ++this.toastSeq,
      };
    }
    // Stale until the reconnect's fresh screen:state arrives.
    this.screen = NO_SHARE;
    this.publish();
  };

  private onSignal = (msg: { from: string; data: RtcSignalData }): void => {
    if (this.disposed || !msg || !isSignal(msg.data)) return;
    const peer = this.share?.peers.get(msg.from);
    if (peer) {
      this.handleSharerSignal(msg.from, peer, msg.data);
      return;
    }
    const v = this.view;
    if (v && msg.from === v.sharerId) {
      this.handleViewerSignal(v, msg.data);
    }
    // Anything else (unknown / stale peer) is ignored.
  };

  /* ---------------------------------------------------------------- */
  /* sharer                                                            */
  /* ---------------------------------------------------------------- */

  async startShare(): Promise<void> {
    if (this.disposed || this.share || this.starting) return;
    if (!canShareScreen()) return;
    this.starting = true;
    this.publish();

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: false,
      });
    } catch (err) {
      this.starting = false;
      // Dismissing the picker is a choice, not an error.
      if (isPickerCancel(err)) this.publish();
      else this.notify("error", "Couldn't capture the screen.");
      return;
    }
    this.starting = false;

    if (this.disposed) {
      stopTracks(stream);
      return;
    }
    if (!this.socket.connected) {
      stopTracks(stream);
      this.notify("error", "Not connected to the server — try again.");
      return;
    }

    const session: ShareSession = {
      stream,
      peers: new Map(),
      viewers: new Set(),
      started: false,
      live: false,
      closed: false,
    };
    this.share = session;
    for (const track of stream.getVideoTracks()) {
      // Tell the encoder this is text/UI, not motion: favours sharpness.
      track.contentHint = "detail";
    }
    for (const track of stream.getTracks()) {
      // The browser's own "Stop sharing" bar (or the shared window closing)
      // ends the track without going through our UI.
      track.onended = () => {
        if (this.share === session) this.teardownShare(true);
      };
    }

    session.started = true;
    this.publish();
    const r = await awaitAck((ack) => this.socket.emit("screen:start", ack));
    // Stopped (or unmounted) while waiting: teardown already emitted stop,
    // which the server processes after the start.
    if (this.disposed || session.closed || this.share !== session) return;
    if (r === "timeout" || !r.ok) {
      // Emitting stop after a timeout covers a start that landed late; after
      // "busy" it's a server-side no-op.
      this.teardownShare(true);
      this.notify(
        "error",
        messageForScreenStart(r === "timeout" ? "timeout" : r.error),
      );
      return;
    }
    session.live = true;
    this.publish();
  }

  stopShare(): void {
    this.teardownShare(true);
  }

  private teardownShare(emitStop: boolean): void {
    this.starting = false;
    const s = this.share;
    if (!s) {
      this.publish();
      return;
    }
    s.closed = true;
    this.share = null;
    for (const peer of s.peers.values()) peer.pc.close();
    s.peers.clear();
    stopTracks(s.stream);
    if (emitStop && s.started) {
      this.emitIfConnected(() => this.socket.emit("screen:stop"));
    }
    this.publish();
  }

  private closeSharerPeer(viewerId: string): void {
    const s = this.share;
    const peer = s?.peers.get(viewerId);
    if (!s || !peer) return;
    s.peers.delete(viewerId);
    peer.pc.close();
  }

  private onViewerJoined = (viewerId: string): void => {
    const s = this.share;
    if (this.disposed || !s || s.closed || !s.started) return;
    if (typeof viewerId !== "string" || !viewerId) return;
    // A re-join (viewer's Retry) replaces its old peer outright.
    this.closeSharerPeer(viewerId);
    if (!s.viewers.has(viewerId)) {
      s.viewers.add(viewerId);
      this.publish();
    }

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const peer: SharerPeer = { pc, queue: new CandidateQueue() };
    s.peers.set(viewerId, peer);
    const stale = () =>
      this.disposed || s.closed || s.peers.get(viewerId) !== peer;

    for (const track of s.stream.getTracks()) pc.addTrack(track, s.stream);
    pc.onicecandidate = (e) => {
      if (stale()) return;
      this.signal(viewerId, {
        type: "candidate",
        // null = end-of-candidates, forwarded so the viewer's ICE can settle.
        candidate: e.candidate ? e.candidate.toJSON() : null,
      });
    };

    void (async () => {
      try {
        const offer = await pc.createOffer();
        if (stale()) return;
        await pc.setLocalDescription(offer);
        if (stale()) return;
        const sdp = pc.localDescription?.sdp ?? offer.sdp;
        if (!sdp) return;
        this.signal(viewerId, { type: "offer", sdp });
        // After negotiation starts so the sender has encodings to configure.
        void preferResolution(pc);
      } catch {
        if (!stale()) this.closeSharerPeer(viewerId);
      }
    })();
  };

  private onViewerLeft = (viewerId: string): void => {
    this.closeSharerPeer(viewerId);
    if (this.share?.viewers.delete(viewerId)) this.publish();
  };

  private handleSharerSignal(
    viewerId: string,
    peer: SharerPeer,
    data: RtcSignalData,
  ): void {
    const { pc } = peer;
    const stale = () =>
      this.disposed || this.share?.peers.get(viewerId) !== peer;
    if (data.type === "answer") {
      if (pc.signalingState !== "have-local-offer") return;
      void (async () => {
        try {
          await pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
          if (stale()) return;
          for (const c of peer.queue.drain()) addCandidate(pc, c);
        } catch {
          if (!stale()) this.closeSharerPeer(viewerId);
        }
      })();
    } else if (data.type === "candidate") {
      if (pc.remoteDescription) addCandidate(pc, data.candidate);
      else peer.queue.push(data.candidate);
    }
    // A viewer never sends offers; ignore one if it does.
  }

  /* ---------------------------------------------------------------- */
  /* viewer                                                            */
  /* ---------------------------------------------------------------- */

  async watch(): Promise<void> {
    if (this.disposed || this.view || !this.socket.connected) return;
    const sharer = this.screen.sharer;
    if (!sharer || sharer.id === this.socket.id) return;
    const view: ViewSession = {
      sharer,
      // Set before emitting join so an offer that races the ack is accepted.
      sharerId: sharer.id,
      status: "joining",
      pc: null,
      stream: null,
      queue: new CandidateQueue(),
      timer: null,
      closed: false,
    };
    this.view = view;
    this.publish();
    await this.join(view);
  }

  /** Re-emit screen:join (the server treats it as a re-join, and the sharer
   *  replaces our peer with a fresh offer). */
  retryWatch(): void {
    const v = this.view;
    if (!v || v.status === "joining" || v.closed) return;
    this.resetViewerPeer(v);
    void this.join(v);
  }

  closeViewer(): void {
    // Emit leave even mid-join: the server processes it after the join.
    this.teardownView(true);
  }

  private async join(view: ViewSession): Promise<void> {
    const r = await awaitAck((ack) => this.socket.emit("screen:join", ack));
    if (this.disposed || view.closed || this.view !== view) return;
    if (r === "timeout" || !r.ok) {
      this.teardownView(r === "timeout");
      this.notify(
        "error",
        messageForScreenJoin(r === "timeout" ? "timeout" : r.error),
      );
      return;
    }
    // The ack names the sharer; trust it over our snapshot of screen:state.
    view.sharerId = r.id;
    if (view.status === "joining") view.status = "connecting";
    this.armViewerTimeout(view);
    this.publish();
  }

  private armViewerTimeout(view: ViewSession): void {
    if (view.timer) clearTimeout(view.timer);
    view.timer = setTimeout(() => {
      view.timer = null;
      if (this.view !== view || view.closed) return;
      if (view.status !== "connected") this.failView(view);
    }, VIEWER_CONNECT_TIMEOUT_MS);
  }

  private resetViewerPeer(view: ViewSession): void {
    view.pc?.close();
    view.pc = null;
    view.stream = null;
    view.queue.clear();
    view.status = "connecting";
    this.armViewerTimeout(view);
    this.publish();
  }

  private failView(view: ViewSession): void {
    if (view.timer) clearTimeout(view.timer);
    view.timer = null;
    view.pc?.close();
    view.pc = null;
    view.stream = null;
    view.status = "failed";
    this.publish();
  }

  private teardownView(emitLeave: boolean): void {
    const v = this.view;
    if (!v) return;
    v.closed = true;
    this.view = null;
    if (v.timer) clearTimeout(v.timer);
    v.pc?.close();
    v.pc = null;
    if (emitLeave) this.emitIfConnected(() => this.socket.emit("screen:leave"));
    this.publish();
  }

  private handleViewerSignal(view: ViewSession, data: RtcSignalData): void {
    if (view.status === "failed") return;
    if (data.type === "offer") {
      this.acceptOffer(view, data.sdp);
    } else if (data.type === "candidate") {
      const pc = view.pc;
      if (pc?.remoteDescription) addCandidate(pc, data.candidate);
      else view.queue.push(data.candidate);
    }
  }

  private acceptOffer(view: ViewSession, sdp: string): void {
    // Every offer is a fresh session from the sharer (we never renegotiate),
    // so replace any previous peer. Its candidates always follow the offer.
    view.pc?.close();
    view.queue.clear();
    view.stream = null;
    const pc = new RTCPeerConnection(RTC_CONFIG);
    view.pc = pc;
    const stale = () =>
      this.disposed || view.closed || this.view !== view || view.pc !== pc;

    pc.ontrack = (e) => {
      if (stale()) return;
      view.stream = e.streams[0] ?? new MediaStream([e.track]);
      this.publish();
    };
    pc.onicecandidate = (e) => {
      if (stale()) return;
      this.signal(view.sharerId, {
        type: "candidate",
        candidate: e.candidate ? e.candidate.toJSON() : null,
      });
    };
    const onState = () => {
      if (stale()) return;
      // connectionState is the modern signal; iceConnectionState covers
      // older Safari, which lacks connectionState.
      const failed =
        pc.connectionState === "failed" || pc.iceConnectionState === "failed";
      const connected =
        pc.connectionState === "connected" ||
        (pc.connectionState === undefined &&
          (pc.iceConnectionState === "connected" ||
            pc.iceConnectionState === "completed"));
      if (failed) {
        this.failView(view);
      } else if (connected && view.status !== "connected") {
        view.status = "connected";
        if (view.timer) clearTimeout(view.timer);
        view.timer = null;
        this.publish();
      }
    };
    pc.onconnectionstatechange = onState;
    pc.oniceconnectionstatechange = onState;

    void (async () => {
      try {
        await pc.setRemoteDescription({ type: "offer", sdp });
        if (stale()) return;
        for (const c of view.queue.drain()) addCandidate(pc, c);
        const answer = await pc.createAnswer();
        if (stale()) return;
        await pc.setLocalDescription(answer);
        if (stale()) return;
        const local = pc.localDescription?.sdp ?? answer.sdp;
        if (local) this.signal(view.sharerId, { type: "answer", sdp: local });
      } catch {
        if (!stale()) this.failView(view);
      }
    })();
  }
}

export interface ScreenShareApi extends ScreenSnapshot {
  startShare: () => void;
  stopShare: () => void;
  watch: () => void;
  retryWatch: () => void;
  closeViewer: () => void;
  dismissToast: (id: number) => void;
}

/**
 * Screen-share state + actions for App. `active` gates it on the auth gate,
 * mirroring App's socket lifecycle effect.
 *
 * ORDERING: call this hook BEFORE App's socket lifecycle effect. Effects run
 * in declaration order, so this registers its listeners before that effect
 * calls socket.connect() — screen:state is sent on connection and would
 * otherwise be lost. Cleanup likewise mirrors that effect (which disconnects).
 */
export function useScreenShare(
  socket: AppSocket,
  active: boolean,
): ScreenShareApi {
  const [snap, setSnap] = useState<ScreenSnapshot>(INITIAL);
  const ctrl = useRef<ScreenShareController | null>(null);

  useEffect(() => {
    if (!active) return;
    const c = new ScreenShareController(socket, setSnap);
    c.attach();
    ctrl.current = c;
    return () => {
      c.dispose();
      if (ctrl.current === c) ctrl.current = null;
      setSnap(INITIAL);
    };
  }, [socket, active]);

  const startShare = useCallback(() => void ctrl.current?.startShare(), []);
  const stopShare = useCallback(() => ctrl.current?.stopShare(), []);
  const watch = useCallback(() => void ctrl.current?.watch(), []);
  const retryWatch = useCallback(() => ctrl.current?.retryWatch(), []);
  const closeViewer = useCallback(() => ctrl.current?.closeViewer(), []);
  const dismissToast = useCallback(
    (id: number) => ctrl.current?.dismissToast(id),
    [],
  );

  return {
    ...snap,
    startShare,
    stopShare,
    watch,
    retryWatch,
    closeViewer,
    dismissToast,
  };
}
