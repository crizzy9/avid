package app.avid.playback

import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.system.StructStat
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.Resetter
import java.io.FileDescriptor
import java.io.IOException
import java.nio.channels.FileChannel
import java.nio.file.AccessDeniedException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.NoSuchFileException
import java.nio.file.Paths
import java.nio.file.StandardOpenOption

/** Robolectric's stock lstat reports synthetic attributes for missing paths. These six Android
 * filesystem calls use the host's actual Unix files, permissions, symlinks, and fsync instead.
 * SQLite itself remains the AOSP native runtime. This does not simulate Android power loss. */
@Implements(Os::class)
class LibraryFileOs {
    companion object {
        private val channels = mutableMapOf<FileDescriptor, FileChannel>()
        private inline fun <T> filesystem(name: String, action: () -> T): T = try { action() } catch (error: IOException) {
            val errno = when (error) { is NoSuchFileException -> OsConstants.ENOENT; is AccessDeniedException -> OsConstants.EACCES; else -> OsConstants.EIO }
            throw ErrnoException(name, errno, error)
        }
        private fun attributes(path: String, follow: Boolean): StructStat = filesystem("stat") {
            val options = if (follow) emptyArray() else arrayOf(LinkOption.NOFOLLOW_LINKS)
            val fields = Files.readAttributes(Paths.get(path), "unix:*", *options)
            fun long(key: String) = (fields[key] as Number).toLong()
            StructStat(long("dev"), long("ino"), long("mode").toInt(), long("nlink"), long("uid").toInt(), long("gid").toInt(),
                long("rdev"), long("size"), 0, 0, 0, 4096, (long("size") + 511) / 512)
        }
        @JvmStatic @Implementation fun stat(path: String): StructStat = attributes(path, true)
        @JvmStatic @Implementation fun lstat(path: String): StructStat = attributes(path, false)
        @JvmStatic @Implementation fun chmod(path: String, mode: Int) = filesystem("chmod") {
            Files.setAttribute(Paths.get(path), "unix:mode", mode); Unit
        }
        @JvmStatic @Implementation @Synchronized fun open(path: String, flags: Int, mode: Int): FileDescriptor = filesystem("open") {
            require(flags == OsConstants.O_RDONLY) { "This test adapter only opens directories read-only." }
            FileDescriptor().also { channels[it] = FileChannel.open(Paths.get(path), StandardOpenOption.READ) }
        }
        @JvmStatic @Implementation @Synchronized fun fsync(descriptor: FileDescriptor) = filesystem("fsync") {
            val channel = channels[descriptor] ?: throw ErrnoException("fsync", OsConstants.EBADF)
            channel.force(true)
        }
        @JvmStatic @Implementation @Synchronized fun close(descriptor: FileDescriptor) = filesystem("close") {
            val channel = channels.remove(descriptor) ?: throw ErrnoException("close", OsConstants.EBADF)
            channel.close()
        }
        @JvmStatic @Resetter @Synchronized fun reset() { channels.values.forEach { it.close() }; channels.clear() }
    }
}
