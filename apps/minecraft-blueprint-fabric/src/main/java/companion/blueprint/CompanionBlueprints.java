package companion.blueprint;

import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.phys.AABB;

import java.io.IOException;
import java.nio.file.Path;
import java.util.regex.Pattern;

public final class CompanionBlueprints implements ModInitializer {
    private static final long LEASE_NS = 5_000_000_000L;
    private static final long TICK_BUDGET_NS = 6_000_000L;
    private static final int CELLS_PER_TICK = 65_536;
    private static final Pattern ID = Pattern.compile("[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}");
    private static final Pattern NONCE = Pattern.compile("[0-9a-f]{16}");
    private static final Pattern HASH = Pattern.compile("[0-9a-f]{64}");
    private static final Pattern PLAYER = Pattern.compile("[a-zA-Z0-9_]{1,16}");
    private static final Pattern REASON = Pattern.compile("blueprint-[a-z-]+|-");
    private static final String CARPET_PLAYER = "carpet.patches.EntityPlayerMPFake";

    private Job job;
    private Result latest;

    @Override
    public void onInitialize() {
        CommandRegistrationCallback.EVENT.register((dispatcher, access, environment) -> dispatcher.register(
            Commands.literal("companionblueprint")
                .requires(source -> source.hasPermission(4) && source.getEntity() == null && source.getTextName().equals("Server"))
                .then(Commands.argument("fields", StringArgumentType.greedyString())
                    .executes(context -> command(context.getSource(), StringArgumentType.getString(context, "fields"))))));
        ServerTickEvents.END_SERVER_TICK.register(server -> {
            if (job == null || job.level.getServer() != server) return;
            try { job.tick(); }
            catch (RuntimeException error) { job.finish("failed", "blueprint-world-write-unconfirmed"); }
            if (job.terminal()) {
                latest = job.result();
                job = null;
            }
        });
        ServerLifecycleEvents.SERVER_STOPPING.register(server -> {
            if (job != null && job.level.getServer() == server) {
                job.finish("cancelled", "blueprint-server-stopping");
                job = null;
            }
            latest = null;
        });
    }

    private int command(CommandSourceStack source, String fields) {
        String[] args = fields.split(" ", -1);
        if (args.length < 3 || !ID.matcher(args[1]).matches() || !NONCE.matcher(args[2]).matches()) return 0;
        String operation = args[0], id = args[1], nonce = args[2];
        Result result;
        if (operation.equals("start")) {
            if (args.length != 13 || !HASH.matcher(args[4]).matches() || !PLAYER.matcher(args[12]).matches() ||
                !(args[3].equals("preview") || args[3].equals("build"))) return 0;
            result = start(source, args, id);
        } else if (args.length == 3 && (operation.equals("status") || operation.equals("cancel"))) {
            if (job != null && job.id.equals(id)) {
                if (operation.equals("cancel")) {
                    job.finish("cancelled", "blueprint-stopped");
                    latest = job.result();
                    job = null;
                    result = latest;
                } else {
                    // An expired lease cannot be recovered by a late status request.
                    if (System.nanoTime() >= job.lease) job.finish("cancelled", "blueprint-lease-expired");
                    else job.renew();
                    result = job.result();
                }
            } else {
                result = latest != null && latest.id.equals(id) ? latest : Result.failure(id, "-", "blueprint-operation-unavailable");
            }
        } else return 0;
        source.sendSuccess(() -> Component.literal(result.line(nonce)), false);
        return 1;
    }

    private Result start(CommandSourceStack source, String[] args, String id) {
        String hash = args[4];
        if (job != null) return Result.failure(id, hash, "blueprint-world-busy");
        if (latest != null && latest.id.equals(id)) return Result.failure(id, hash, "blueprint-operation-reused");
        ServerLevel level = source.getLevel();
        ServerPlayer bot = source.getServer().getPlayerList().getPlayerByName(args[12]);
        if (bot == null || !bot.getClass().getName().equals(CARPET_PLAYER) || bot.serverLevel() != level || !bot.isAlive()) {
            return Result.failure(id, hash, "blueprint-bot-unavailable");
        }
        try {
            int x = Integer.parseInt(args[5]), y = Integer.parseInt(args[6]), z = Integer.parseInt(args[7]);
            int width = Integer.parseInt(args[8]), height = Integer.parseInt(args[9]), depth = Integer.parseInt(args[10]);
            int solids = Integer.parseInt(args[11]);
            long endX = (long) x + width - 1, endY = (long) y + height - 1, endZ = (long) z + depth - 1;
            if (width < 1 || width > 256 || height < 1 || height > 256 || depth < 1 || depth > 256 ||
                x < -29_999_984 || endX > 29_999_983 || z < -29_999_984 || endZ > 29_999_983 ||
                y < level.getMinBuildHeight() || endY >= level.getMaxBuildHeight()) {
                return Result.failure(id, hash, "blueprint-site-bounds");
            }
            BlockPos min = new BlockPos(x, y, z), max = new BlockPos((int) endX, (int) endY, (int) endZ);
            if (!level.getWorldBorder().isWithinBounds(min) || !level.getWorldBorder().isWithinBounds(max)) {
                return Result.failure(id, hash, "blueprint-site-bounds");
            }
            for (int chunkZ = z >> 4; chunkZ <= (endZ >> 4); chunkZ++) {
                for (int chunkX = x >> 4; chunkX <= (endX >> 4); chunkX++) {
                    if (level.getChunkSource().getChunkNow(chunkX, chunkZ) == null) return Result.failure(id, hash, "blueprint-site-unloaded");
                }
            }
            Schematic schematic = Schematic.read(Path.of("companion-blueprint-jobs", id + ".schem"), hash);
            if (width != schematic.width() || height != schematic.height() || depth != schematic.depth() || solids != schematic.solids()) {
                return Result.failure(id, hash, "blueprint-shape-mismatch");
            }
            job = new Job(id, hash, args[3].equals("build"), level, bot, min, schematic);
            return job.result();
        } catch (IOException | CommandSyntaxException error) {
            return Result.failure(id, hash, "blueprint-invalid-schematic");
        } catch (RuntimeException error) {
            String reason = error.getMessage();
            return Result.failure(id, hash, reason != null && REASON.matcher(reason).matches() ? reason : "blueprint-invalid-schematic");
        }
    }

    private record Result(String id, String hash, String phase, int total, int solids, int checked, int matched,
                          int placed, boolean restored, String reason) {
        static Result failure(String id, String hash, String reason) {
            return new Result(id, hash, "failed", 0, 0, 0, 0, 0, true, reason);
        }

        String line(String nonce) {
            return "companion-blueprint id=" + id + " nonce=" + nonce + " hash=" + hash + " phase=" + phase +
                " total=" + total + " solids=" + solids + " checked=" + checked + " matched=" + matched + " placed=" + placed +
                " restored=" + restored + " reason=" + reason;
        }
    }

    private static final class Job {
        final String id, hash;
        final boolean build;
        final ServerLevel level;
        final ServerPlayer bot;
        final BlockPos min;
        final Schematic schematic;
        final AABB bounds;
        final BlockPos.MutableBlockPos position = new BlockPos.MutableBlockPos();
        String phase = "checking", reason = "-";
        int cursor, matched, placed;
        long lease;
        GameType previousMode;
        boolean restored = true;

        Job(String id, String hash, boolean build, ServerLevel level, ServerPlayer bot, BlockPos min, Schematic schematic) {
            this.id = id;
            this.hash = hash;
            this.build = build;
            this.level = level;
            this.bot = bot;
            this.min = min;
            this.schematic = schematic;
            bounds = new AABB(min.getX(), min.getY(), min.getZ(), min.getX() + schematic.width(), min.getY() + schematic.height(), min.getZ() + schematic.depth());
            renew();
        }

        void renew() { lease = System.nanoTime() + LEASE_NS; }

        boolean terminal() { return switch (phase) {
            case "checking", "placing", "verifying" -> false;
            default -> true;
        }; }

        Result result() {
            return new Result(id, hash, phase, schematic.cells().length, schematic.solids(), cursor, matched, placed, restored, reason);
        }

        void finish(String outcome, String detail) {
            if (terminal()) return;
            if (previousMode != null) {
                bot.setGameMode(previousMode);
                restored = bot.gameMode.getGameModeForPlayer() == previousMode;
            }
            phase = restored ? outcome : "failed";
            reason = restored ? detail : "blueprint-mode-restore-unconfirmed";
        }

        void tick() {
            if (terminal()) return;
            long now = System.nanoTime();
            if (now >= lease) { finish("cancelled", "blueprint-lease-expired"); return; }
            if (!bot.isAlive() || bot.serverLevel() != level || level.getServer().getPlayerList().getPlayer(bot.getUUID()) != bot) {
                finish("failed", "blueprint-bot-unavailable"); return;
            }
            if (level.players().stream().anyMatch(player -> player.getBoundingBox().intersects(bounds))) {
                finish("failed", "blueprint-site-player-present"); return;
            }
            boolean verifying = phase.equals("verifying"), placing = phase.equals("placing");
            if ((placing || verifying) && !bot.isCreative()) { finish("failed", "blueprint-creative-unconfirmed"); return; }
            int end = Math.min(cursor + CELLS_PER_TICK, schematic.cells().length);
            while (cursor < end) {
                if ((cursor & 255) == 0 && System.nanoTime() >= now + TICK_BUDGET_NS) return;
                int width = schematic.width(), depth = schematic.depth();
                position.set(min.getX() + cursor % width, min.getY() + cursor / (width * depth), min.getZ() + cursor / width % depth);
                if (level.getChunkSource().getChunkNow(position.getX() >> 4, position.getZ() >> 4) == null) {
                    finish("failed", "blueprint-site-unloaded"); return;
                }
                int index = schematic.cells()[cursor] & 255;
                var expected = schematic.palette()[index];
                var current = level.getBlockState(position);
                if (index == 0 ? current.isAir() : current == expected) {
                    if (index != 0) matched++;
                } else if (verifying || index == 0 || !current.isAir()) {
                    finish("failed", verifying ? "blueprint-site-verification-failed" : "blueprint-site-obstructed"); return;
                } else if (placing) {
                    if (!level.setBlock(position, expected, Block.UPDATE_CLIENTS | Block.UPDATE_KNOWN_SHAPE)) {
                        finish("failed", "blueprint-world-write-unconfirmed"); return;
                    }
                    placed++;
                }
                cursor++;
            }
            if (cursor != schematic.cells().length) return;
            if (verifying) { finish("built", "-"); return; }
            if (placing) { phase = "verifying"; cursor = matched = 0; return; }
            if (!build) { finish("ready", "-"); return; }
            previousMode = bot.gameMode.getGameModeForPlayer();
            bot.setGameMode(GameType.CREATIVE);
            restored = false;
            if (!bot.isCreative()) { finish("failed", "blueprint-creative-unconfirmed"); return; }
            phase = "placing";
            cursor = matched = 0;
        }
    }
}
