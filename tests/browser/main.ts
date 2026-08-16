import React from 'react'
import { createRoot } from 'react-dom/client'
import { apply } from '../../src/client/index.js'

let Footer: React.ComponentType<{ wide: boolean }> | undefined
const slots = {
  inject(key: string, setup: () => unknown) {
    document.body.dataset.injectedSlot = key
    setup()
    return () => undefined
  },
  register(options: { name: string; id: string }, component: React.ComponentType<{ wide: boolean }>) {
    document.body.dataset.registeredSlot = options.name
    document.body.dataset.registrationId = options.id
    Footer = component
    return () => undefined
  },
}

apply({ slots } as never)
if (Footer === undefined) throw new Error('dsh-worktree did not register its sidebar footer component')
createRoot(document.getElementById('root')!).render(React.createElement(Footer, { wide: true }))
