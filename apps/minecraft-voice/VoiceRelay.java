package companion.minecraft;

import de.maxhenkel.voicechat.api.VoicechatPlugin;
import de.maxhenkel.voicechat.api.VoicechatServerApi;
import de.maxhenkel.voicechat.api.audiochannel.AudioPlayer;
import de.maxhenkel.voicechat.api.audiochannel.StaticAudioChannel;
import de.maxhenkel.voicechat.api.events.EventRegistration;
import de.maxhenkel.voicechat.api.events.VoicechatServerStartedEvent;
import de.maxhenkel.voicechat.api.events.VoicechatServerStoppedEvent;

import javax.sound.sampled.AudioFormat;
import javax.sound.sampled.AudioSystem;
import java.io.BufferedInputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.FileTime;
import java.time.Instant;
import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/** Plays Companion replies to a single authenticated Minecraft player. */
public final class VoiceRelay implements VoicechatPlugin {
    private static final System.Logger LOG = System.getLogger(VoiceRelay.class.getName());
    private static final AudioFormat PCM = new AudioFormat(48_000, 16, 1, true, false);
    private static final int MAX_PCM_BYTES = 48_000 * 2 * 30;
    private static final int MAX_REPLY_BYTES = 3_000_000;
    private final Path directory = Path.of(System.getProperty("companion.voice.dir",
        Path.of(System.getProperty("user.home"), ".local/share/companion/minecraft/voice").toString()));
    private final HttpClient companion = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
    private CompletableFuture<Boolean> joined = CompletableFuture.completedFuture(false);
    private ScheduledExecutorService scheduler;
    private UUID listener;
    private AudioPlayer player;
    private boolean ownerOnline;

    @Override
    public String getPluginId() {
        return "companion_voice";
    }

    @Override
    public void registerEvents(EventRegistration events) {
        events.registerEvent(VoicechatServerStartedEvent.class, event -> start(event.getVoicechat()));
        events.registerEvent(VoicechatServerStoppedEvent.class, event -> stop());
    }

    private synchronized void start(VoicechatServerApi api) {
        stop();
        try {
            Path config = directory.resolve("owner");
            if (!Files.isRegularFile(config, LinkOption.NOFOLLOW_LINKS) || Files.size(config) > 64) return;
            UUID owner = UUID.fromString(Files.readString(config).strip());
            scheduler = Executors.newSingleThreadScheduledExecutor(job -> {
                Thread thread = new Thread(job, "Companion Minecraft voice");
                thread.setDaemon(true);
                return thread;
            });
            scheduler.scheduleWithFixedDelay(() -> poll(api, owner), 0, 300, TimeUnit.MILLISECONDS);
            LOG.log(System.Logger.Level.INFO, "Companion private Minecraft voice relay enabled");
        } catch (IOException | IllegalArgumentException error) {
            LOG.log(System.Logger.Level.WARNING, "Companion voice owner configuration unavailable");
        }
    }

    private synchronized void stop() {
        if (scheduler != null) scheduler.shutdownNow();
        scheduler = null;
        ownerOnline = false;
        joined = CompletableFuture.completedFuture(false);
        clearListener();
    }

    private CompletableFuture<Boolean> gameAction(String action, String body) {
        var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:18788/companion/api/minecraft/" + action))
            .timeout(Duration.ofSeconds(30))
            .header("X-Companion-Request", "1")
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body)).build();
        return companion.sendAsync(request, HttpResponse.BodyHandlers.discarding())
            .handle((response, error) -> {
                boolean accepted = error == null && response.statusCode() == 202;
                if (!accepted) LOG.log(System.Logger.Level.WARNING, "Companion Minecraft " + action + " unavailable");
                return accepted;
            });
    }

    private void clearListener() {
        if (player != null) player.stopPlaying();
        player = null;
        try {
            Files.deleteIfExists(directory.resolve("listener"));
            if (listener != null) Files.deleteIfExists(directory.resolve(listener + ".wav"));
        } catch (IOException error) {
            LOG.log(System.Logger.Level.WARNING, "Companion voice listener cleanup unavailable");
        } finally {
            listener = null;
        }
    }

    private synchronized void poll(VoicechatServerApi api, UUID owner) {
        if (scheduler == null) return;
        try {
            var connection = api.getConnectionOf(owner);
            boolean nowOnline = connection != null;
            if (ownerOnline != nowOnline) {
                ownerOnline = nowOnline;
                if (ownerOnline) joined = joined.thenCompose(ignored -> gameAction("connect", "{\"atOwner\":true}"));
                else joined = joined.thenCompose(wasJoined -> wasJoined
                    ? gameAction("disconnect", "{}") : CompletableFuture.completedFuture(false));
            }
            if (connection == null || !connection.isConnected() || connection.isDisabled()) {
                if (listener != null) clearListener();
                return;
            }
            Path lease = directory.resolve("listener");
            if (listener == null) {
                UUID next = UUID.randomUUID();
                Path temp = Files.createTempFile(directory, ".listener-", ".part");
                try {
                    Files.writeString(temp, next.toString());
                    Files.move(temp, lease, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
                    listener = next;
                } finally {
                    Files.deleteIfExists(temp);
                }
            } else {
                Files.setLastModifiedTime(lease, FileTime.from(Instant.now()));
            }
            if (player != null && !player.isStopped()) return;
            Path audio = directory.resolve(listener + ".wav");
            if (!Files.isRegularFile(audio, LinkOption.NOFOLLOW_LINKS)) return;
            Path claimed = directory.resolve(listener + ".playing");
            try {
                Files.move(audio, claimed, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (NoSuchFileException stale) {
                return;
            }
            short[] samples;
            try {
                long ageMs = System.currentTimeMillis() - Files.getLastModifiedTime(claimed).toMillis();
                if (ageMs >= 8_000 || Files.size(claimed) > MAX_REPLY_BYTES) return;
                samples = samples(claimed);
            } finally {
                Files.deleteIfExists(claimed);
            }
            if (samples.length == 0 || !connection.isConnected() || connection.isDisabled()) return;
            StaticAudioChannel channel = api.createStaticAudioChannel(UUID.randomUUID());
            if (channel == null) return;
            channel.addTarget(connection);
            channel.setBypassGroupIsolation(true);
            var encoder = api.createEncoder();
            try {
                player = api.createAudioPlayer(channel, encoder, samples);
                player.startPlaying();
            } catch (RuntimeException error) {
                encoder.close();
                throw error;
            }
        } catch (Exception error) {
            clearListener();
            LOG.log(System.Logger.Level.WARNING, "Companion voice reply skipped: " + error.getClass().getSimpleName());
        }
    }

    static short[] samples(Path audio) throws Exception {
        try (var input = new BufferedInputStream(Files.newInputStream(audio, LinkOption.NOFOLLOW_LINKS));
             var wave = AudioSystem.getAudioInputStream(input);
             var pcm = AudioSystem.getAudioInputStream(PCM, wave)) {
            byte[] bytes = pcm.readNBytes(MAX_PCM_BYTES + 2);
            if (bytes.length > MAX_PCM_BYTES || bytes.length % 2 != 0) throw new IOException("Invalid audio size");
            short[] result = new short[bytes.length / 2];
            ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(result);
            return result;
        }
    }
}
