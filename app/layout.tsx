import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'ConfFit — Conference Submission Agent',
  description:
    'An agent that adapts a research paper to a target conference: re-frames the contribution for the venue and fixes the submission format.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
