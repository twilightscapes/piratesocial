/** @jsxImportSource preact */
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';

// Extract YouTube video ID from various URL formats
function getYouTubeId(url) {
  if (!url) return null;
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([^&?\s]+)/);
  return m ? m[1] : null;
}

// Build full playlist from primary URL + tracks
function buildPlaylist(url, heading, tracks) {
  const items = [];
  const mainId = getYouTubeId(url);
  if (mainId) items.push({ id: mainId, title: heading || 'Track 1' });
  if (tracks && tracks.length) {
    tracks.forEach((t, i) => {
      const tid = getYouTubeId(t.url);
      if (tid) items.push({ id: tid, title: t.title || `Track ${items.length + 1}` });
    });
  }
  return items;
}

export default function YouTubePlayer({ url, heading, caption, audioOnly, display = 'docked', tracks, layout = 'contained' }) {
  const playlist = buildPlaylist(url, heading, tracks);
  const isFloating = display === 'floating';
  const hasPlaylist = playlist.length > 1;

  // If no valid videos, render nothing
  if (playlist.length === 0) return null;

  // Simple docked video embed (no audio, no floating)
  if (!isFloating && !audioOnly) {
    const videoId = playlist[0].id;
    const wrapperClass = layout === 'full' ? '' : 'max-w-4xl mx-auto';
    return (
      <section class={`mb-12 ${wrapperClass}`}>
        {heading && <h2 class="mb-4 text-xl font-semibold">{heading}</h2>}
        <div class="relative w-full overflow-hidden rounded-lg" style="padding-bottom:56.25%">
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${videoId}${hasPlaylist ? '?autoplay=0' : ''}`}
            title={heading || 'YouTube video'}
            class="absolute inset-0 h-full w-full"
            frameBorder="0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>
        {caption && <p class="mt-2 text-sm text-center" style="color:var(--ps-text-muted)">{caption}</p>}
      </section>
    );
  }

  // Interactive player (floating or docked audio)
  return <InteractivePlayer
    playlist={playlist}
    audioOnly={audioOnly}
    isFloating={isFloating}
    heading={heading}
    caption={caption}
    layout={layout}
  />;
}

function InteractivePlayer({ playlist, audioOnly, isFloating, heading, caption, layout }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [volume, setVolume] = useState(80);
  const [showPlaylist, setShowPlaylist] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [position, setPosition] = useState({ side: 'bottom' }); // bottom, left, right
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [dragOffset, setDragOffset] = useState(null); // {x, y} when dragging
  const [dragPos, setDragPos] = useState(null); // {x, y} custom position from drag
  const playerRef = useRef(null);
  const containerRef = useRef(null);
  const iframeRef = useRef(null);
  const progressInterval = useRef(null);
  const isDragging = useRef(false);
  const hasPlaylist = playlist.length > 1;
  const current = playlist[currentIndex] || playlist[0];

  // Load YouTube IFrame API
  useEffect(() => {
    if (window.YT && window.YT.Player) return;
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  }, []);

  // Create/update player
  useEffect(() => {
    if (!started) return;

    function initPlayer() {
      if (playerRef.current) {
        playerRef.current.loadVideoById(current.id);
        return;
      }

      playerRef.current = new window.YT.Player(iframeRef.current, {
        videoId: current.id,
        host: 'https://www.youtube-nocookie.com',
        playerVars: {
          autoplay: 1,
          controls: 0,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          iv_load_policy: 3,
          disablekb: 1,
          fs: 0,
        },
        events: {
          onReady: (e) => {
            e.target.setVolume(volume);
            e.target.playVideo();
            setIsPlaying(true);
            setDuration(e.target.getDuration());
          },
          onStateChange: (e) => {
            if (e.data === window.YT.PlayerState.PLAYING) {
              setIsPlaying(true);
              setDuration(e.target.getDuration());
              clearInterval(progressInterval.current);
              progressInterval.current = setInterval(() => {
                if (playerRef.current && playerRef.current.getCurrentTime) {
                  setProgress(playerRef.current.getCurrentTime());
                }
              }, 500);
            } else if (e.data === window.YT.PlayerState.PAUSED) {
              setIsPlaying(false);
              clearInterval(progressInterval.current);
            } else if (e.data === window.YT.PlayerState.ENDED) {
              clearInterval(progressInterval.current);
              // Auto-advance or loop
              if (currentIndex < playlist.length - 1) {
                setCurrentIndex(currentIndex + 1);
              } else {
                setCurrentIndex(0); // loop
              }
            }
          },
        },
      });
    }

    if (window.YT && window.YT.Player) {
      initPlayer();
    } else {
      window.onYouTubeIframeAPIReady = initPlayer;
    }

    return () => clearInterval(progressInterval.current);
  }, [started, current.id]);

  // Volume changes
  useEffect(() => {
    if (playerRef.current && playerRef.current.setVolume) {
      playerRef.current.setVolume(volume);
    }
  }, [volume]);

  const togglePlay = useCallback(() => {
    if (!started) {
      setStarted(true);
      return;
    }
    if (!playerRef.current) return;
    if (isPlaying) {
      playerRef.current.pauseVideo();
    } else {
      playerRef.current.playVideo();
    }
  }, [started, isPlaying]);

  const skipTo = useCallback((idx) => {
    setCurrentIndex(idx);
    if (playerRef.current && playerRef.current.loadVideoById) {
      playerRef.current.loadVideoById(playlist[idx].id);
    }
  }, [playlist]);

  const prevTrack = useCallback(() => {
    const idx = currentIndex > 0 ? currentIndex - 1 : playlist.length - 1;
    skipTo(idx);
  }, [currentIndex, playlist.length, skipTo]);

  const nextTrack = useCallback(() => {
    const idx = currentIndex < playlist.length - 1 ? currentIndex + 1 : 0;
    skipTo(idx);
  }, [currentIndex, playlist.length, skipTo]);

  const seekTo = useCallback((e) => {
    if (!playerRef.current || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const time = pct * duration;
    playerRef.current.seekTo(time, true);
    setProgress(time);
  }, [duration]);

  const formatTime = (s) => {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const cycleSide = useCallback(() => {
    setDragPos(null); // reset custom drag position
    const sides = ['bottom', 'right', 'left'];
    const idx = sides.indexOf(position.side);
    setPosition({ side: sides[(idx + 1) % sides.length] });
  }, [position.side]);

  // ── Drag handlers for floating player ──
  const onDragStart = useCallback((e) => {
    if (!isFloating || !containerRef.current) return;
    // Ignore if target is a button/input/range
    if (e.target.closest('button, input, [role="button"]')) return;
    e.preventDefault();
    const touch = e.touches ? e.touches[0] : e;
    const rect = containerRef.current.getBoundingClientRect();
    isDragging.current = true;
    setDragOffset({ x: touch.clientX - rect.left, y: touch.clientY - rect.top });
  }, [isFloating]);

  const onDragMove = useCallback((e) => {
    if (!isDragging.current || !dragOffset) return;
    e.preventDefault();
    const touch = e.touches ? e.touches[0] : e;
    const x = Math.max(0, Math.min(window.innerWidth - 60, touch.clientX - dragOffset.x));
    const y = Math.max(0, Math.min(window.innerHeight - 60, touch.clientY - dragOffset.y));
    setDragPos({ x, y });
  }, [dragOffset]);

  const onDragEnd = useCallback(() => {
    isDragging.current = false;
    setDragOffset(null);
  }, []);

  useEffect(() => {
    if (!isFloating) return;
    const moveHandler = (e) => onDragMove(e);
    const endHandler = () => onDragEnd();
    window.addEventListener('mousemove', moveHandler);
    window.addEventListener('mouseup', endHandler);
    window.addEventListener('touchmove', moveHandler, { passive: false });
    window.addEventListener('touchend', endHandler);
    return () => {
      window.removeEventListener('mousemove', moveHandler);
      window.removeEventListener('mouseup', endHandler);
      window.removeEventListener('touchmove', moveHandler);
      window.removeEventListener('touchend', endHandler);
    };
  }, [isFloating, onDragMove, onDragEnd]);

  // ── Docked audio player (inline on page) ──
  if (!isFloating) {
    const wrapperClass = layout === 'full' ? '' : 'max-w-4xl mx-auto';
    return (
      <section class={`mb-12 ${wrapperClass}`}>
        {heading && <h2 class="mb-4 text-xl font-semibold">{heading}</h2>}

        {/* Hidden YouTube iframe */}
        <div style="position:absolute;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none">
          <div ref={iframeRef} />
        </div>

        <div class="rounded-lg border overflow-hidden" style="border-color:var(--ps-card-border);background:var(--ps-card-bg)">
          {/* Main controls */}
          <div class="flex items-center gap-3 p-4">
            {/* Play/Pause */}
            <button onClick={togglePlay} class="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center" style="background:var(--ps-primary);color:#fff" aria-label={isPlaying ? 'Pause' : 'Play'}>
              {isPlaying
                ? <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                : <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
              }
            </button>

            {/* Track info + progress */}
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium truncate" style="color:var(--ps-text)">{current.title}</div>
              {started && (
                <div class="flex items-center gap-2 mt-1">
                  <span class="text-xs" style="color:var(--ps-text-faint)">{formatTime(progress)}</span>
                  <div class="flex-1 h-1.5 rounded-full cursor-pointer" style="background:var(--ps-border)" onClick={seekTo}>
                    <div class="h-full rounded-full transition-all" style={`width:${duration ? (progress / duration * 100) : 0}%;background:var(--ps-primary)`} />
                  </div>
                  <span class="text-xs" style="color:var(--ps-text-faint)">{formatTime(duration)}</span>
                </div>
              )}
            </div>

            {/* Skip buttons */}
            {hasPlaylist && (
              <div class="flex items-center gap-1">
                <button onClick={prevTrack} class="p-1.5 rounded" style="color:var(--ps-text-muted)" aria-label="Previous">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="19,20 9,12 19,4"/><rect x="5" y="4" width="3" height="16"/></svg>
                </button>
                <button onClick={nextTrack} class="p-1.5 rounded" style="color:var(--ps-text-muted)" aria-label="Next">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,4 15,12 5,20"/><rect x="16" y="4" width="3" height="16"/></svg>
                </button>
              </div>
            )}

            {/* Volume */}
            <div class="flex items-center gap-1.5 w-24">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--ps-text-faint);flex-shrink:0"><polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/></svg>
              <input type="range" min="0" max="100" value={volume} onInput={(e) => setVolume(Number(e.target.value))}
                class="w-full h-1 rounded-full appearance-none cursor-pointer"
                style="accent-color:var(--ps-primary);background:var(--ps-border)"
              />
            </div>

            {/* Playlist toggle */}
            {hasPlaylist && (
              <button onClick={() => setShowPlaylist(!showPlaylist)} class="p-1.5 rounded" style={`color:${showPlaylist ? 'var(--ps-primary)' : 'var(--ps-text-muted)'}`} aria-label="Playlist">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
              </button>
            )}
          </div>

          {/* Playlist */}
          {hasPlaylist && showPlaylist && (
            <div class="border-t px-2 py-1 max-h-48 overflow-y-auto" style="border-color:var(--ps-border)">
              {playlist.map((track, i) => (
                <button key={track.id} onClick={() => skipTo(i)}
                  class="w-full flex items-center gap-2 px-3 py-2 rounded text-left text-sm transition"
                  style={`color:${i === currentIndex ? 'var(--ps-primary)' : 'var(--ps-text)'};background:${i === currentIndex ? 'var(--ps-surface-hover)' : 'transparent'}`}
                >
                  <span class="w-5 text-xs text-right flex-shrink-0" style="color:var(--ps-text-faint)">
                    {i === currentIndex && isPlaying ? '♫' : `${i + 1}`}
                  </span>
                  <span class="truncate">{track.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Show video for docked non-audioOnly (with controls built-in) */}
        {!audioOnly && started && (
          <div class="mt-4 rounded-lg overflow-hidden" style="aspect-ratio:16/9">
            <div ref={iframeRef} style="width:100%;height:100%" />
          </div>
        )}

        {caption && <p class="mt-2 text-sm text-center" style="color:var(--ps-text-muted)">{caption}</p>}
      </section>
    );
  }

  // ── Floating mini player ──
  const posStyles = {
    bottom: { bottom: '72px', left: '50%', transform: 'translateX(-50%)', maxWidth: minimized ? '48px' : '380px' },
    right: { bottom: '72px', right: '16px', maxWidth: minimized ? '48px' : '340px' },
    left: { bottom: '72px', left: '16px', maxWidth: minimized ? '48px' : '340px' },
  };
  const pos = dragPos
    ? { left: `${dragPos.x}px`, top: `${dragPos.y}px`, maxWidth: minimized ? '48px' : '380px' }
    : (posStyles[position.side] || posStyles.bottom);

  return (
    <div ref={containerRef}
      style={{
        position: 'fixed', zIndex: 9999,
        transition: isDragging.current ? 'none' : 'all 0.3s ease',
        ...pos,
        width: minimized ? '48px' : '100%',
      }}
    >
      {/* Hidden YouTube iframe */}
      <div style="position:absolute;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none">
        <div ref={iframeRef} />
      </div>

      {/* Minimized nub */}
      {minimized ? (
        <button onClick={() => setMinimized(false)}
          class="w-12 h-12 rounded-full flex items-center justify-center shadow-lg"
          style="background:var(--ps-primary);color:#fff"
          aria-label="Expand player"
        >
          {isPlaying
            ? <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
            : <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
          }
        </button>
      ) : (
        <div class="rounded-xl shadow-2xl border overflow-hidden" style="background:var(--ps-card-bg);border-color:var(--ps-card-border);backdrop-filter:blur(20px)">
          {/* Top bar — drag handle + minimize */}
          <div class="flex items-center justify-between px-3 py-1.5 border-b"
            style="border-color:var(--ps-border);cursor:grab;user-select:none;-webkit-user-select:none"
            onMouseDown={onDragStart}
            onTouchStart={onDragStart}
          >
            <button onClick={cycleSide} class="text-xs px-1.5 py-0.5 rounded" style="color:var(--ps-text-faint)" aria-label="Change position" title="Change position">
              ⇄
            </button>
            <span class="text-xs font-medium truncate mx-2 flex items-center gap-1" style="color:var(--ps-text-faint)">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style="opacity:0.5"><circle cx="9" cy="5" r="2"/><circle cx="15" cy="5" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="9" cy="19" r="2"/><circle cx="15" cy="19" r="2"/></svg>
              {audioOnly ? '♫ Audio Player' : '▶ Player'}
            </span>
            <button onClick={() => setMinimized(true)} class="text-xs px-1.5 py-0.5 rounded" style="color:var(--ps-text-faint)" aria-label="Minimize">
              ─
            </button>
          </div>

          {/* Progress bar */}
          {started && (
            <div class="h-1 cursor-pointer" style="background:var(--ps-border)" onClick={seekTo}>
              <div class="h-full transition-all" style={`width:${duration ? (progress / duration * 100) : 0}%;background:var(--ps-primary)`} />
            </div>
          )}

          {/* Controls */}
          <div class="flex items-center gap-2 px-3 py-2">
            {/* Prev */}
            {hasPlaylist && (
              <button onClick={prevTrack} class="p-1 rounded" style="color:var(--ps-text-muted)" aria-label="Previous">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="19,20 9,12 19,4"/><rect x="5" y="4" width="3" height="16"/></svg>
              </button>
            )}

            {/* Play/Pause */}
            <button onClick={togglePlay} class="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center" style="background:var(--ps-primary);color:#fff" aria-label={isPlaying ? 'Pause' : 'Play'}>
              {isPlaying
                ? <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                : <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
              }
            </button>

            {/* Next */}
            {hasPlaylist && (
              <button onClick={nextTrack} class="p-1 rounded" style="color:var(--ps-text-muted)" aria-label="Next">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,4 15,12 5,20"/><rect x="16" y="4" width="3" height="16"/></svg>
              </button>
            )}

            {/* Track title */}
            <div class="flex-1 min-w-0 mx-1">
              <div class="text-xs font-medium truncate" style="color:var(--ps-text)">{current.title}</div>
              {started && <div class="text-xs" style="color:var(--ps-text-faint)">{formatTime(progress)} / {formatTime(duration)}</div>}
            </div>

            {/* Volume */}
            <input type="range" min="0" max="100" value={volume} onInput={(e) => setVolume(Number(e.target.value))}
              class="w-14 h-1 rounded-full appearance-none cursor-pointer"
              style="accent-color:var(--ps-primary);background:var(--ps-border)"
            />

            {/* Playlist toggle */}
            {hasPlaylist && (
              <button onClick={() => setShowPlaylist(!showPlaylist)} class="p-1 rounded" style={`color:${showPlaylist ? 'var(--ps-primary)' : 'var(--ps-text-muted)'}`} aria-label="Playlist">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
              </button>
            )}
          </div>

          {/* Playlist popout */}
          {hasPlaylist && showPlaylist && (
            <div class="border-t px-1 py-1 max-h-40 overflow-y-auto" style="border-color:var(--ps-border)">
              {playlist.map((track, i) => (
                <button key={track.id} onClick={() => skipTo(i)}
                  class="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-xs transition"
                  style={`color:${i === currentIndex ? 'var(--ps-primary)' : 'var(--ps-text)'};background:${i === currentIndex ? 'var(--ps-surface-hover)' : 'transparent'}`}
                >
                  <span class="w-4 text-right flex-shrink-0" style="color:var(--ps-text-faint)">
                    {i === currentIndex && isPlaying ? '♫' : `${i + 1}`}
                  </span>
                  <span class="truncate">{track.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
