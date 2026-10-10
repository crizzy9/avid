package app.avid.playback

import okhttp3.Call
import okhttp3.Dns
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Response
import okio.ByteString.Companion.decodeBase64
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.Proxy
import java.net.SocketTimeoutException
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Dedicated credential-free LAN transport. No shared cookies, proxies, redirects, or retries. */
internal class CrossPointTransport {
    data class Head(val id: String, val status: Int, val message: String, val headers: List<List<String>>)
    data class Chunk(val bytes: ByteArray, val done: Boolean)
    data class Reader(val address: String, val hostname: String)
    private class Transfer {
        val created = System.nanoTime()
        @Volatile var cancelled = false
        @Volatile var call: Call? = null
        @Volatile var response: Response? = null
        @Volatile var socket: DatagramSocket? = null
        var read = 0L
        var limit = 0L
        fun cancel() { cancelled = true; call?.cancel(); response?.close(); socket?.close() }
    }
    private val transfers = mutableMapOf<String, Transfer>()
    private val cancelled = mutableMapOf<String, Long>()
    @Synchronized private fun begin(id: String): Transfer {
        require(UUID.fromString(id).toString() == id) { "Invalid reader request ID." }
        val now = System.nanoTime()
        cancelled.entries.removeAll { now - it.value > TimeUnit.SECONDS.toNanos(120) }
        transfers.entries.removeAll { if (now - it.value.created > TimeUnit.SECONDS.toNanos(120)) { it.value.cancel(); true } else false }
        require(!cancelled.containsKey(id) && cancelled.size < 256 && transfers.size < 8 && !transfers.containsKey(id)) { "Reader request canceled or too many active requests." }
        return Transfer().also { transfers[id] = it }
    }
    @Synchronized fun close(id: String) {
        require(UUID.fromString(id).toString() == id)
        val now = System.nanoTime()
        cancelled.entries.removeAll { now - it.value > TimeUnit.SECONDS.toNanos(120) }
        if (cancelled.size < 256) cancelled[id] = now
        transfers.remove(id)?.cancel()
    }
    @Synchronized fun dispose() { transfers.values.forEach { it.cancel() }; transfers.clear() }
    @Synchronized private fun transfer(id: String) = transfers[id] ?: error("The reader response is closed.")
    fun open(id: String, raw: String, method: String, headers: List<List<String>>, encoded: String?): Head {
        val transfer = begin(id)
        try {
            val (url, limit) = route(raw, method)
            require(headers.size <= 16)
            val addresses = InetAddress.getAllByName(url.host).toList()
            require(addresses.isNotEmpty() && addresses.size <= 32 && addresses.all(::local)) { "The reader must resolve to a local-network address." }
            // A fixed reserved alias confines Android's cleartext exception to this dedicated client.
            // The checked private addresses are pinned; the wire Host still identifies the chosen reader.
            val routed = if (url.isHttps) url else url.newBuilder().host("crosspoint.avid.invalid").build()
            val client = IsolatedHttp.client(35).newBuilder().proxy(Proxy.NO_PROXY)
                .dns(object: Dns { override fun lookup(hostname: String): List<InetAddress> { require(hostname == routed.host); return addresses } }).build()
            val request = Request.Builder().url(routed).header("Host", url.toUri().rawAuthority)
            if (method == "POST") {
                val content = headers.filter { it.size == 2 && it[0].equals("content-type", true) }
                require(content.size == 1 && content[0][1].startsWith("multipart/form-data; boundary=") && content[0][1].length <= 256 && !content[0][1].contains('\r') && !content[0][1].contains('\n'))
                require(encoded != null && encoded.length <= 4 * ((UPLOAD_LIMIT + 2) / 3)) { "The EPUB upload exceeds 64 MiB." }
                val bytes = encoded.decodeBase64()?.toByteArray() ?: error("Invalid upload bytes.")
                require(bytes.isNotEmpty() && bytes.size <= UPLOAD_LIMIT)
                request.post(bytes.toRequestBody(content[0][1].toMediaType()))
            } else require(encoded == null)
            val call = client.newCall(request.build())
            transfer.call = call
            if (transfer.cancelled) { call.cancel(); error("The reader request was canceled.") }
            val response = call.execute()
            synchronized(transfer) {
                if (transfer.cancelled) { response.close(); error("The reader request was canceled.") }
                transfer.response = response; transfer.limit = limit.toLong()
            }
            require(response.code !in 300..399) { "The reader redirected the request. No redirected request was sent." }
            require((response.body?.contentLength() ?: 0) <= limit) { "The reader response exceeds the transfer limit." }
            return Head(id, response.code, response.message, response.headers.toList().filter { it.first.lowercase() in setOf("content-type", "content-length") }.map { listOf(it.first, it.second) })
        } catch (error: Exception) { close(id); throw error }
    }
    fun read(id: String): Chunk {
        val transfer = transfer(id)
        try {
            val result = synchronized(transfer) {
                check(!transfer.cancelled)
                val body = transfer.response?.body ?: error("The reader response has not opened.")
                val bytes = ByteArray(256 * 1024)
                val count = body.byteStream().read(bytes)
                check(!transfer.cancelled)
                if (count < 0) Chunk(byteArrayOf(), true) else {
                    transfer.read += count
                    require(transfer.read <= transfer.limit) { "The reader response exceeded the transfer limit." }
                    Chunk(bytes.copyOf(count), false)
                }
            }
            if (result.done) close(id)
            return result
        } catch (error: Exception) { close(id); throw error }
    }
    fun discover(id: String): List<Reader> {
        val transfer = begin(id)
        try {
            val socket = DatagramSocket().apply { broadcast = true; soTimeout = 100 }
            transfer.socket = socket
            if (transfer.cancelled) { socket.close(); error("Discovery canceled.") }
            val targets = mutableSetOf(InetAddress.getByName("255.255.255.255"))
            NetworkInterface.getNetworkInterfaces()?.toList()?.filter { it.isUp && !it.isLoopback }?.forEach { network ->
                network.interfaceAddresses.mapNotNull { it.broadcast }.forEach { targets.add(it) }
            }
            fun send() { var sent = false; targets.forEach { address -> try { socket.send(DatagramPacket("hello".toByteArray(Charsets.UTF_8), 5, address, 8134)); sent = true } catch (_: Exception) {} }; check(sent) { "Allow local-network access or enter the reader IP." } }
            send()
            val started = System.nanoTime(); var resent = false
            val readers = linkedMapOf<String, Reader>()
            while (System.nanoTime() - started < TimeUnit.SECONDS.toNanos(4) && readers.size < 32) {
                check(!transfer.cancelled)
                if (!resent && System.nanoTime() - started > TimeUnit.SECONDS.toNanos(2)) { send(); resent = true }
                try {
                    val packet = DatagramPacket(ByteArray(257), 257); socket.receive(packet)
                    if (packet.port == 8134) reply(packet.data.copyOf(packet.length), packet.address)?.let { readers[it.address] = it }
                } catch (_: SocketTimeoutException) {}
            }
            return readers.values.sortedBy { it.address }
        } finally { close(id) }
    }
    companion object {
        const val FILE_LIMIT = 64 * 1024 * 1024
        const val UPLOAD_LIMIT = FILE_LIMIT + 64 * 1024
        fun local(ip: InetAddress): Boolean = ip.isLoopbackAddress || ip.isSiteLocalAddress || ip.isLinkLocalAddress || (ip.address.size == 16 && (ip.address[0].toInt() and 0xfe) == 0xfc)
        private fun path(value: String): Boolean = value.startsWith('/') && value.length <= 4096 && value.none { it.code < 32 || it.code == 127 || it in "\\%<>:\"|?*" } && value.split('/').filter { it.isNotEmpty() }.all { !it.startsWith('.') && !it.endsWith('.') && !it.endsWith(' ') && it.lowercase() !in listOf("system volume information", "xtcache") }
        fun route(raw: String, method: String): Pair<HttpUrl, Int> {
            require(raw.length <= 16384)
            val url = raw.toHttpUrl()
            require(url.username.isEmpty() && url.password.isEmpty() && url.fragment == null && url.querySize == 1)
            val key = url.queryParameterName(0); val value = url.queryParameterValue(0) ?: ""
            val limit = when {
                method == "GET" && url.encodedPath == "/api/status" && key == "plugin" && value == "avid" -> 64 * 1024
                method == "GET" && url.encodedPath == "/api/files" && key == "path" && path(value) -> 2 * 1024 * 1024
                method == "GET" && url.encodedPath == "/download" && key == "path" && path(value) && value.lowercase().endsWith(".epub") -> FILE_LIMIT
                method == "POST" && url.encodedPath == "/upload" && key == "path" && path(value) -> 64 * 1024
                else -> error("Only the pinned CrossPoint routes are supported.")
            }
            return url to limit
        }
        fun reply(bytes: ByteArray, ip: InetAddress): Reader? {
            if (bytes.size > 256 || ip !is Inet4Address || !local(ip)) return null
            val match = Regex("^crosspoint \\(on ([A-Za-z0-9_.-]{1,128})\\);([0-9]{1,5})$").matchEntire(String(bytes, Charsets.US_ASCII)) ?: return null
            if ((match.groupValues[2].toIntOrNull() ?: 0) !in 1..65535) return null
            // The advertised suffix is the WebSocket upload port; HTTP remains port 80.
            return Reader("http://${ip.hostAddress}", match.groupValues[1])
        }
    }
}
