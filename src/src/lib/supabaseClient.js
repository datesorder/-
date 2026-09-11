import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://ieyvsbpzqzabvvetshre.supabase.co'
const supabasePublishableKey = 'sb_publishable_yzO0Fk2ZF_o6xMGG2TAPtQ_VlXpf7oI'

export const supabase = createClient(
  supabaseUrl,
  supabasePublishableKey
)
