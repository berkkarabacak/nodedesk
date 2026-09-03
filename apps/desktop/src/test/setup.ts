import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Each test renders into a fresh DOM.
afterEach(() => cleanup())
