package companion.blueprint;

import com.mojang.brigadier.exceptions.CommandSyntaxException;
import net.minecraft.commands.arguments.blocks.BlockStateParser;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NbtAccounter;
import net.minecraft.nbt.NbtIo;
import net.minecraft.nbt.Tag;
import net.minecraft.world.level.block.state.BlockState;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.Set;
import java.util.regex.Pattern;

record Schematic(int width, int height, int depth, int solids, byte[] cells, BlockState[] palette) {
    private static final int MAX_FILE = 8 * 1024 * 1024;
    private static final Pattern COLORED = Pattern.compile(
        "(?:white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_(?:concrete|terracotta|stained_glass|wool)");
    private static final Pattern PLANKS = Pattern.compile("(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped)_planks");
    private static final Set<String> SOLID = Set.of("terracotta", "andesite", "bricks", "calcite", "cobblestone", "deepslate_tiles", "diorite",
        "granite", "moss_block", "mud_bricks", "mushroom_stem", "sandstone", "smooth_sandstone", "tuff", "tuff_bricks", "packed_mud",
        "waxed_weathered_cut_copper", "waxed_oxidized_cut_copper", "stripped_acacia_wood", "ochre_froglight", "verdant_froglight",
        "pearlescent_froglight", "glowstone", "glass", "stone", "polished_andesite", "polished_diorite", "polished_granite", "stone_bricks",
        "quartz_block", "smooth_quartz", "blackstone", "polished_blackstone_bricks", "polished_deepslate", "deepslate_bricks");

    static Schematic read(Path path, String expectedHash) throws IOException, CommandSyntaxException {
        byte[] bytes;
        try (var file = Files.newInputStream(path, LinkOption.NOFOLLOW_LINKS)) {
            bytes = file.readNBytes(MAX_FILE + 1);
        }
        if (bytes.length > MAX_FILE) throw new IllegalArgumentException("blueprint-file-too-large");
        if (!hash(bytes).equals(expectedHash)) throw new IllegalArgumentException("blueprint-hash-mismatch");
        CompoundTag root = NbtIo.readCompressed(new ByteArrayInputStream(bytes), NbtAccounter.create(48L * 1024 * 1024));
        CompoundTag schematic = root.getCompound("Schematic");
        if (!root.getAllKeys().equals(Set.of("Schematic")) ||
            !schematic.getAllKeys().equals(Set.of("Version", "DataVersion", "Width", "Height", "Length", "Offset", "Blocks")) ||
            schematic.getInt("Version") != 3 || schematic.getInt("DataVersion") != 3955 ||
            !Arrays.equals(schematic.getIntArray("Offset"), new int[]{0, 0, 0})) throw invalid();
        int width = side(schematic, "Width"), height = side(schematic, "Height"), depth = side(schematic, "Length");
        CompoundTag blocks = schematic.getCompound("Blocks");
        if (!blocks.getAllKeys().equals(Set.of("Palette", "Data")) || !blocks.contains("Data", Tag.TAG_BYTE_ARRAY)) throw invalid();
        CompoundTag names = blocks.getCompound("Palette");
        if (names.size() < 1 || names.size() > 256) throw invalid();
        BlockState[] palette = new BlockState[names.size()];
        for (String name : names.getAllKeys()) {
            int id = names.getInt(name);
            if (!names.contains(name, Tag.TAG_INT) || id < 0 || id >= palette.length || palette[id] != null) throw invalid();
            palette[id] = state(name);
        }
        if (!palette[0].isAir()) throw invalid();

        byte[] data = blocks.getByteArray("Data");
        byte[] cells = new byte[width * height * depth];
        int offset = 0, solids = 0;
        for (int cell = 0; cell < cells.length; cell++) {
            if (offset >= data.length) throw invalid();
            int id = data[offset++] & 255;
            if (id >= 128) {
                if (offset >= data.length || data[offset] != 1) throw invalid();
                offset++;
            }
            if (id >= palette.length) throw invalid();
            cells[cell] = (byte) id;
            if (id != 0) solids++;
        }
        if (offset != data.length || solids == 0) throw invalid();
        return new Schematic(width, height, depth, solids, cells, palette);
    }

    private static int side(CompoundTag tag, String key) {
        int side = tag.getShort(key);
        if (!tag.contains(key, Tag.TAG_SHORT) || side < 1 || side > 256) throw invalid();
        return side;
    }

    private static BlockState state(String name) throws CommandSyntaxException {
        String id = name.split("\\[", 2)[0];
        if (!id.startsWith("minecraft:") || name.length() > 128) throw new IllegalArgumentException("blueprint-unsupported-block");
        String block = id.substring("minecraft:".length());
        if (!name.equals("minecraft:air") && !SOLID.contains(block) && !COLORED.matcher(block).matches() && !PLANKS.matcher(block).matches()) {
            throw new IllegalArgumentException("blueprint-unsupported-block");
        }
        return BlockStateParser.parseForBlock(BuiltInRegistries.BLOCK.asLookup(), name, false).blockState();
    }

    private static String hash(byte[] data) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(data)); }
        catch (NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
    }

    private static IllegalArgumentException invalid() { return new IllegalArgumentException("blueprint-invalid-schematic"); }
}
