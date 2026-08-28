// Remote control viewer: renders a live, clickable view of a browser tab that
// someone shared with the Playwriter extension's "Remote control" button.
//
// The link looks like https://playwriter.dev/remote-control#<tunnelId>. The id is
// a bearer secret, so it lives in the hash: fragments are never sent to a server,
// which keeps the id out of request paths, access logs, and Referer headers.
// Everything here therefore runs client-side; the server never learns the id.
//
// The tunnel speaks the Playwriter extension protocol rather than raw CDP, so the
// viewer uses the 'extension' transport of CdpViewer.

'use client'

import { buildTunnelOrigin } from 'playwriter/src/remote-control'
import { useEffect, useState } from 'react'
import { Head } from 'spiceflow/react'
import { CdpViewer } from '../components/cdp-screencast.tsx'

function readTunnelIdFromHash(): string | null {
  const id = window.location.hash.slice(1)
  return /^[a-z0-9-]{1,63}$/.test(id) ? id : null
}

export default function RemoteControlPage() {
  const [tunnelId, setTunnelId] = useState<string | null>(null)
  const [initialized, setInitialized] = useState(false)

  // Read the hash on the client only. The server cannot see it, so rendering from
  // it during SSR would always disagree with the client and break hydration.
  useEffect(() => {
    const apply = () => {
      setTunnelId(readTunnelIdFromHash())
      setInitialized(true)
    }
    apply()
    window.addEventListener('hashchange', apply)
    return () => {
      window.removeEventListener('hashchange', apply)
    }
  }, [])

  const wsUrl = tunnelId ? `${buildTunnelOrigin({ tunnelId }).replace(/^https/, 'wss')}/extension` : null

  return (
    <>
      <Head>
        <title>Remote Control | Playwriter</title>
        <meta name="description" content="Watch and control a browser tab shared with you through Playwriter." />
        {/* The id is in the hash, but keep referrers off entirely as defence in depth. */}
        <meta name="referrer" content="no-referrer" />
        <meta name="robots" content="noindex, nofollow" />
      </Head>

      <div className="flex h-screen w-screen flex-col bg-neutral-950">
        {!initialized ? (
          <div className="flex flex-1 items-center justify-center">
            <svg className="size-6 animate-spin text-white/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
            </svg>
          </div>
        ) : wsUrl ? (
          <div className="flex flex-1 items-center justify-center p-4">
            <div className="h-full w-full max-w-[1400px]">
              <CdpViewer wsUrl={wsUrl} transport="extension" />
            </div>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4">
            <h1 className="text-2xl font-semibold text-white">Remote Control</h1>
            <p className="max-w-md text-center text-sm text-white/50">
              This page needs a share link. Ask the person sharing their tab to click the light-blue <strong className="text-white/70">Remote control</strong> button in
              the Playwriter toolbar and send you the link they get.
            </p>
            <p className="text-xs text-white/30">
              Links look like <code className="rounded bg-white/5 px-1.5 py-0.5">playwriter.dev/remote-control#your-id</code>
            </p>
          </div>
        )}
      </div>
    </>
  )
}
