import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

interface StreamSession {
  id: string
  sourceUrl: string
  clientCount: number
  websocket?: WebSocket
  clients: Set<WebSocket>
  isActive: boolean
}

// Armazenar sessões de stream ativas
const streamSessions = new Map<string, StreamSession>()

serve(async (req) => {
  const { pathname, searchParams } = new URL(req.url)
  const { headers } = req
  const upgradeHeader = headers.get("upgrade") || ""

  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Rota para criar/gerenciar retransmissão de stream
  if (pathname === '/create-relay') {
    const streamUrl = searchParams.get('url')
    const sessionId = searchParams.get('sessionId') || crypto.randomUUID()
    
    if (!streamUrl) {
      return new Response(JSON.stringify({ error: 'URL da stream é obrigatória' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Criar ou recuperar sessão de stream
    let session = streamSessions.get(sessionId)
    if (!session) {
      session = {
        id: sessionId,
        sourceUrl: streamUrl,
        clientCount: 0,
        clients: new Set(),
        isActive: false
      }
      streamSessions.set(sessionId, session)
    }

    return new Response(JSON.stringify({ 
      sessionId: session.id,
      relayUrl: `/relay/${session.id}`,
      httpUrl: `/stream/${session.id}`,
      clientCount: session.clientCount
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  // Rota WebSocket para retransmissão
  if (pathname.startsWith('/relay/')) {
    const sessionId = pathname.split('/')[2]
    
    if (upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("WebSocket connection required", { 
        status: 400,
        headers: corsHeaders
      })
    }

    const { socket, response } = Deno.upgradeWebSocket(req)
    
    let session = streamSessions.get(sessionId)
    if (!session) {
      socket.close(1008, "Sessão não encontrada")
      return response
    }

    // Adicionar cliente à sessão
    session.clients.add(socket)
    session.clientCount = session.clients.size

    console.log(`Cliente conectado à sessão ${sessionId}. Total: ${session.clientCount}`)

    // Iniciar retransmissão se for o primeiro cliente
    if (session.clientCount === 1 && !session.isActive) {
      startStreamRelay(session)
    }

    socket.onclose = () => {
      session.clients.delete(socket)
      session.clientCount = session.clients.size
      console.log(`Cliente desconectado da sessão ${sessionId}. Restam: ${session.clientCount}`)
      
      // Parar retransmissão se não há mais clientes
      if (session.clientCount === 0) {
        stopStreamRelay(session)
      }
    }

    socket.onerror = (error) => {
      console.error(`Erro no WebSocket da sessão ${sessionId}:`, error)
      session.clients.delete(socket)
      session.clientCount = session.clients.size
    }

    return response
  }

  // Rota HTTP para stream replicada
  if (pathname.startsWith('/stream/')) {
    const sessionId = pathname.split('/')[2]
    const session = streamSessions.get(sessionId)
    
    if (!session || !session.isActive) {
      return new Response("Stream não disponível", { 
        status: 404,
        headers: corsHeaders
      })
    }

    // Retornar informações da stream para HTTP
    return new Response(JSON.stringify({
      sessionId: session.id,
      sourceUrl: session.sourceUrl,
      clientCount: session.clientCount,
      isActive: session.isActive,
      httpStreamUrl: `${req.url}/m3u8` // Para HLS
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  // Status das sessões ativas
  if (pathname === '/status') {
    const activeSessions = Array.from(streamSessions.values()).map(session => ({
      id: session.id,
      sourceUrl: session.sourceUrl,
      clientCount: session.clientCount,
      isActive: session.isActive
    }))

    return new Response(JSON.stringify({ 
      activeSessions,
      totalSessions: streamSessions.size
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  return new Response("Rota não encontrada", { 
    status: 404,
    headers: corsHeaders
  })
})

// Função para iniciar retransmissão de stream
async function startStreamRelay(session: StreamSession) {
  try {
    console.log(`Iniciando retransmissão para sessão ${session.id}`)
    
    // Conectar à fonte original
    const response = await fetch(session.sourceUrl)
    if (!response.ok) {
      throw new Error(`Falha ao conectar à fonte: ${response.status}`)
    }

    session.isActive = true
    
    // Processar stream e distribuir para clientes
    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error("Não foi possível ler a stream")
    }

    // Loop de retransmissão
    while (session.isActive && session.clientCount > 0) {
      const { done, value } = await reader.read()
      
      if (done) {
        console.log(`Stream da sessão ${session.id} terminou`)
        break
      }

      // Distribuir dados para todos os clientes conectados
      const disconnectedClients: WebSocket[] = []
      
      for (const client of session.clients) {
        try {
          if (client.readyState === WebSocket.OPEN) {
            client.send(value)
          } else {
            disconnectedClients.push(client)
          }
        } catch (error) {
          console.error(`Erro ao enviar dados para cliente:`, error)
          disconnectedClients.push(client)
        }
      }

      // Remover clientes desconectados
      disconnectedClients.forEach(client => {
        session.clients.delete(client)
      })
      session.clientCount = session.clients.size
    }

    reader.releaseLock()
    
  } catch (error) {
    console.error(`Erro na retransmissão da sessão ${session.id}:`, error)
  } finally {
    stopStreamRelay(session)
  }
}

// Função para parar retransmissão
function stopStreamRelay(session: StreamSession) {
  console.log(`Parando retransmissão da sessão ${session.id}`)
  
  session.isActive = false
  
  // Fechar todas as conexões de clientes
  for (const client of session.clients) {
    try {
      client.close(1000, "Stream encerrada")
    } catch (error) {
      console.error("Erro ao fechar cliente:", error)
    }
  }
  
  session.clients.clear()
  session.clientCount = 0
  
  // Remover sessão após um tempo
  setTimeout(() => {
    streamSessions.delete(session.id)
    console.log(`Sessão ${session.id} removida`)
  }, 30000) // 30 segundos
}