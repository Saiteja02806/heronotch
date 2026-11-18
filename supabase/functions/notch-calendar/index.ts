import { createCalendarHandler } from './handler.ts'

declare const Deno: {
  env: { get(name: string): string | undefined }
  serve(handler: (request: Request) => Promise<Response>): void
}

Deno.serve(createCalendarHandler({
  supabaseUrl: Deno.env.get('SUPABASE_URL') || '',
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
  googleClientId: Deno.env.get('NOTCH_GOOGLE_CLIENT_ID') || '',
  googleClientSecret: Deno.env.get('NOTCH_GOOGLE_CLIENT_SECRET') || '',
  encryptionKey: Deno.env.get('NOTCH_CALENDAR_ENCRYPTION_KEY') || ''
}))
