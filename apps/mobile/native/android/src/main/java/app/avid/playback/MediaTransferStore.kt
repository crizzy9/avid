package app.avid.playback

import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.URI
import java.security.MessageDigest
import java.util.UUID

internal data class MediaAccount(val generation: String, val scope: String?)
internal data class MediaIdentity(val scope: String, val bookId: String, val fileId: String, val trackId: String)
internal data class MediaReceipt(val id: String, val identity: MediaIdentity, val size: Long, val mime: String, val sha256: String)

/** Private files are usable only through an immutable receipt and the currently active account. */
internal class MediaTransferStore(root: File, private val account: () -> MediaAccount,
    private val now: () -> Long = { System.nanoTime() / 1_000_000 }) {
    private val root = root.canonicalFile
    private data class Pending(val id: String, val identity: MediaIdentity, val generation: String, val size: Long,
        val mime: String, val created: Long, val digest: MessageDigest = MessageDigest.getInstance("SHA-256"), var offset: Long = 0)
    private val pending = mutableMapOf<String, Pending>()
    private val receipts = mutableMapOf<String, MediaReceipt>()

    init {
        require(root.mkdirs() || root.isDirectory)
        root.listFiles().orEmpty().filter { it.name.endsWith(".receipt") }.forEach { file ->
            runCatching {
                require(file.length() in 1..65536)
                DataInputStream(FileInputStream(file)).use { input ->
                    require(input.readInt() == 1)
                    val value = MediaReceipt(input.readUTF(), MediaIdentity(input.readUTF(), input.readUTF(), input.readUTF(), input.readUTF()),
                        input.readLong(), input.readUTF(), input.readUTF())
                    require(validId(value.id) && file.name == "${value.id}.receipt" && value.size in 1..MAX_FILE && audio(value.id).length() == value.size)
                    require(value.sha256.matches(Regex("[0-9a-f]{64}")))
                    receipts[value.id] = value
                }
            }.onFailure { file.delete() }
        }
        // Transfers cannot be resumed across process death. No incomplete bytes become playable.
        root.listFiles().orEmpty().filter { it.name.endsWith(".part") || it.name.endsWith(".tmp") ||
            (it.name.endsWith(".audio") && it.name.removeSuffix(".audio") !in receipts) }.forEach { it.delete() }
    }

    @Synchronized fun begin(identity: MediaIdentity, size: Long, mime: String): String {
        prune()
        val active = account()
        require(allowed(identity.scope, active)) { "This imported audio belongs to another account." }
        require(identity.scope.length in 1..8192 && listOf(identity.bookId, identity.fileId, identity.trackId).all { it.length in 1..2048 })
        require(size in 1..MAX_FILE && mime.length <= 128 && (mime.startsWith("audio/") || mime in setOf("application/octet-stream", "video/mp4", "video/webm"))) { "Unsupported audio import size or media type." }
        require(pending.size < MAX_PENDING) { "Too many audio imports are in progress." }
        require(receipts.size + pending.size < 4096) { "The private audio file limit has been reached." }
        require(receipts.values.sumOf { it.size } + pending.values.sumOf { it.size } <= MAX_TOTAL - size && root.usableSpace >= size + MIN_FREE) { "There is not enough private storage for this audio file." }
        val id = UUID.randomUUID().toString()
        require(part(id).createNewFile())
        pending[id] = Pending(id, identity, active.generation, size, mime, now())
        return id
    }
    @Synchronized fun append(id: String, offset: Long, bytes: ByteArray) {
        val value = requirePending(id)
        require(bytes.isNotEmpty() && bytes.size <= MAX_CHUNK && offset == value.offset && bytes.size.toLong() <= value.size - offset) { "Audio chunks must be bounded, complete, and in order." }
        try {
            FileOutputStream(part(id), true).use { it.write(bytes) }
            value.digest.update(bytes); value.offset += bytes.size
        } catch (error: Exception) { cancel(id); throw error }
    }
    @Synchronized fun finish(id: String): String {
        val value = requirePending(id)
        require(value.offset == value.size && part(id).length() == value.size) { "The audio transfer is incomplete." }
        val receipt = MediaReceipt(id, value.identity, value.size, value.mime, value.digest.digest().joinToString("") { "%02x".format(it) })
        try {
            receipts.values.firstOrNull { it.identity == receipt.identity && it.size == receipt.size && it.sha256 == receipt.sha256 && audio(it.id).length() == it.size }?.let { prior ->
                requireCurrent(value); cancel(id); return audio(prior.id).toURI().toASCIIString()
            }
            FileOutputStream(part(id), true).use { it.fd.sync() }
            require(part(id).renameTo(audio(id))) { "The private audio file could not be committed." }
            val temporary = File(root, "$id.tmp")
            FileOutputStream(temporary).use { stream ->
                val output = DataOutputStream(stream)
                output.writeInt(1); output.writeUTF(id); output.writeUTF(value.identity.scope)
                output.writeUTF(value.identity.bookId); output.writeUTF(value.identity.fileId); output.writeUTF(value.identity.trackId)
                output.writeLong(value.size); output.writeUTF(value.mime); output.writeUTF(receipt.sha256); output.flush(); stream.fd.sync()
            }
            require(temporary.renameTo(File(root, "$id.receipt")))
            requireCurrent(value)
            receipts[id] = receipt; pending.remove(id)
            return audio(id).toURI().toASCIIString()
        } catch (error: Exception) {
            cancel(id); audio(id).delete(); File(root, "$id.receipt").delete(); File(root, "$id.tmp").delete(); throw error
        }
    }
    @Synchronized fun cancel(id: String) {
        require(validId(id))
        pending.remove(id)?.let { part(id).delete() }
    }
    @Synchronized fun validate(url: String, identity: MediaIdentity): Boolean = runCatching {
        require(allowed(identity.scope, account()))
        val uri = URI(url)
        require(uri.scheme == "file" && uri.rawAuthority.isNullOrEmpty() && uri.rawQuery == null && uri.rawFragment == null)
        val candidate = File(uri)
        val id = candidate.name.removeSuffix(".audio")
        require(validId(id) && url == audio(id).toURI().toASCIIString() && candidate.canonicalFile == audio(id).absoluteFile)
        val receipt = receipts[id] ?: return false
        receipt.identity == identity && candidate.isFile && candidate.length() == receipt.size
    }.getOrDefault(false)

    @Synchronized fun clearScope(scope: String) {
        pending.values.filter { it.identity.scope == scope }.map { it.id }.forEach { cancel(it) }
        receipts.values.filter { it.identity.scope == scope }.map { it.id }.forEach { id ->
            // Delete the capability first, so a failed media-file deletion cannot leave a playable receipt.
            require(File(root, "$id.receipt").delete() || !File(root, "$id.receipt").exists())
            receipts.remove(id); audio(id).delete()
        }
    }
    private fun requirePending(id: String): Pending {
        require(validId(id)); prune()
        val value = pending[id] ?: error("This audio transfer is no longer available.")
        requireCurrent(value); return value
    }
    private fun requireCurrent(value: Pending) {
        val active = account()
        require(active.generation == value.generation && allowed(value.identity.scope, active)) { "The account changed during this audio transfer." }
    }
    private fun prune() {
        pending.values.filter { now() - it.created >= PART_TTL }.map { it.id }.forEach { cancel(it) }
    }
    private fun part(id: String) = File(root, "$id.part")
    private fun audio(id: String) = File(root, "$id.audio")
    companion object {
        const val MAX_CHUNK = 256 * 1024
        const val MAX_FILE = 4L * 1024 * 1024 * 1024
        const val MAX_TOTAL = 8L * 1024 * 1024 * 1024
        const val MAX_PENDING = 4
        const val PART_TTL = 60 * 60 * 1000L
        private const val MIN_FREE = 16L * 1024 * 1024
        const val DEMO_SCOPE = "[\"https://demo.avid.invalid\",\"demo\"]"
        fun allowed(scope: String, account: MediaAccount) = account.generation.isNotBlank() &&
            (account.scope == scope || account.scope == null && scope == DEMO_SCOPE)
        private fun validId(id: String) = id.matches(Regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"))
    }
}
