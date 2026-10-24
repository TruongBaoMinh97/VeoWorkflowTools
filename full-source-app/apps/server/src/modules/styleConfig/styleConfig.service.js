import { logger } from '../../lib/logger.js';
/**
 * Style configuration service
 * Cung cấp preambles chuyên nghiệp cho từng style để hướng dẫn Gemini tạo prompts phù hợp
 * Preambles này sau đó sẽ được dùng cả cho Gemini generation và Veo3 expansion
 */
export class StyleConfigService {
    /**
     * Lấy tất cả styles có sẵn
     */
    static getAllStyles() {
        return Object.values(this.STYLES).sort((a, b) => {
            // Sắp xếp: mặc định trước, sau đó theo tên
            if (a.id === 'default')
                return -1;
            if (b.id === 'default')
                return 1;
            return a.name.localeCompare(b.name, 'vi');
        });
    }
    /**
     * Lấy style config theo ID
     */
    static getStyleById(styleId) {
        return this.STYLES[styleId] || null;
    }
    /**
     * Lấy preamble cho một style cụ thể
     */
    static getPreambleByStyleId(styleId) {
        const style = this.getStyleById(styleId);
        if (!style) {
            logger.warn('[StyleConfig] Style not found, using default', { styleId });
            return this.STYLES.default.preamble;
        }
        return style.preamble;
    }
    /**
     * Validate style ID
     */
    static isValidStyle(styleId) {
        return styleId in this.STYLES;
    }
}
StyleConfigService.STYLES = {
    default: {
        id: 'default',
        name: 'Mặc định',
        namePreamble: 'Default Professional',
        preamble: `Phân cảnh: Tóm tắt một câu về hành động và bối cảnh chính.

Hình ảnh: Mô tả chi tiết chủ thể, bối cảnh, kiểu ánh sáng (VD: giờ vàng, u ám, neon), bảng màu, và thẩm mỹ tổng thể (VD: siêu thực, hoạt hình, điện ảnh).

Camera: Chỉ định kiểu shot (VD: medium close-up, wide shot), góc quay (VD: low-angle, eye-level), và chuyển động (VD: slow dolly in, static, gentle pan).

Âm thanh: Chi tiết đầy đủ về cảnh âm thanh (soundscape) - bao gồm âm lệnh, thoại, âm hưởng.

Hiệu ứng âm: Liệt kê các hiệu ứng âm cụ thể, diegetic (VD: tiếng lửa cháy, tiếng còi nước, tiếng sóng lăn nhẹ).

Nhạc nền: Mô tả phong cách và tâm trạng của bài hát nền (VD: piano buồn tinh tế, swell orchestra hùng vĩ, ambient synth tối giản), hoặc nêu rõ "Không có" nếu không cần.`,
    },
    cinema: {
        id: 'cinema',
        name: 'Điện ảnh',
        namePreamble: 'Cinematic Professional',
        preamble: `Phân cảnh: Tóm tắt một câu về hành động và bối cảnh, với tâm trạng điện ảnh.

Hình ảnh: Mô tả chủ thể và bối cảnh với điều kiện ánh sáng kiểu điện ảnh chuyên nghiệp. Nhấn mạnh: độ sâu trường, quản lý ánh sáng kiểu studio (3-point lighting hoặc key-fill-back), độ tương phản và tone màu. Bảng màu phải lạnh hoặc ấm tùy theo cảm xúc. Rõ ràng yêu cầu: "quay phim điện ảnh, chất lượng sinematic, ARRI Alexa, ống kính anamorphic".

Camera: Chỉ định shot cụ thể (VD: Dutch angle, crane shot, tracking shot), aperture gợi ý (shallow depth of field), và chuyển động camera mượt mà (VD: slow push-in, reveal).

Âm thanh: Bộ âm thanh chuyên nghiệp với lớp âm thanh rõ ràng - thoại nổi bật, hiệu ứng stereo hài hòa.

Hiệu ứng âm: Hiệu ứng âm chuyên nghiệp, diegetic, phong phú (tối thiểu 3-4 lớp âm thanh).

Nhạc nền: Nhạc nền điện ảnh chuyên nghiệp - score orchestra, jazz, hoặc ambient điệu, theo tâm trạng cảnh. Phải có cấu trúc rõ ràng với nhịp độ xác định.`,
    },
    noir: {
        id: 'noir',
        name: 'Noir',
        namePreamble: 'Film Noir Aesthetic',
        preamble: `Phân cảnh: Tóm tắt một câu về hành động và bối cảnh với tâm trạng noir đầy lo lắng.

Hình ảnh: Cảnh được render hoàn toàn bằng đen trắng cao độ tương phản. Mô tả chủ thể và bối cảnh qua lăng kính Film Noir Chiaroscuro - ánh sáng low-key, bóng mạnh, atmospheric haze. Nhấn mạnh: "độ tương phản cao, đen trắng", "ánh sáng kịch tính, low-key", "sương mù atmospheric lan tỏa". Nếu có nhân vật, mô tả trang phục thời kỳ (fedora, trench coat, vintage).

Camera: Shot type, góc quay (ưu tiên low-angle hoặc Dutch angle để tạo cảm giác bất ổn), chuyển động camera (thường tĩnh hoặc pan chậm).

Âm thanh: Soundscape im lặng, căng thẳng - thoại khô khan, âm hưởng tối giản.

Hiệu ứng âm: Hiệu ứng âm sparse, diegetic, từ môi trường im lặng hoặc tối (VD: tiếng bước chân trên sàn gỗ, tiếng mở cửa, tiếng lửa). Không quá nhiều, để giữ căng thẳng.

Nhạc nền: Noir jazz - trumpet buồn, upright bass, drums swing chậm. Hoặc ambient noir tối giản. Phải có cảm giác bất an và bí ẩn.`,
    },
    diorama: {
        id: 'diorama',
        name: 'Diorama',
        namePreamble: 'Living Diorama Style',
        preamble: `Phân cảnh: Tóm tắt một câu về hành động và bối cảnh.

Hình ảnh: Cảnh được trình bày dưới dạng Living Diorama - các nhân vật và bối cảnh trông như các mô hình nhựa molded chi tiết cao, với kết thúc bề mặt bóng bằng (semi-gloss). Nhấn mạnh: "chi tiết nhựa molded cao", "kết thúc bóng bằng", "khớp nối articulation hiển thị rõ". Ánh sáng phải sáng và sạch sẽ (studio lighting), không bóng mềm. Không bao giờ trông siêu thực hay hoạt hình - chỉ là đồ chơi điêu khắc chất lượng cao.

Camera: Shot tĩnh hoặc quay từ từ, thường là wide shot hoặc medium shot để thấy toàn bộ diorama.

Âm thanh: Âm thanh nhẹ nhàng, từ phía máy thu, như thể quay phim tài liệu diorama.

Hiệu ứng âm: Hiệu ứng âm chính xác theo nguồn (source-accurate) - nếu có sự kiện trong diorama (VD: bánh xe quay), hãy mô tả âm thanh nhựa/cơ khí nhẹ nhàng.

Nhạc nền: Chỉ nếu yêu cầu - thường là ambient tối giản hoặc không có nhạc.`,
    },
    hyperrealistic: {
        id: 'hyperrealistic',
        name: 'Siêu thực',
        namePreamble: 'Ultra Photorealistic',
        preamble: `Phân cảnh: Tóm tắt một câu về hành động và bối cảnh với chi tiết siêu realism.

Hình ảnh: Mô tả với chi tiết vi mô (micro-details) - lỗ chân lông, phản xạ ánh sáng trên mắt, vải dệt, kết cấu kim loại, hạt bụi trong ánh sáng. Ánh sáng phải tự nhiên đến mức không thể phân biệt với ảnh thật. Nhấn mạnh: "độ chi tiết micro, photorealistic, chất lượng 8K, không khiếm khuyết". Bảng màu chuẩn thực - không bão hòa, quá tối hay quá sáng.

Camera: Shot chuyên nghiệp với shallow DOF, focus stacking hoặc sharp focus tùy bối cảnh.

Âm thanh: Soundscape hoàn chỉnh từ thực tế - mỗi chi tiết âm thanh phải có nguồn gốc rõ ràng.

Hiệu ứng âm: Hiệu ứng âm tự nhiên và tinh tế - không quá phát, chi tiết và có bối cảnh (reverb tự nhiên).

Nhạc nền: Nếu cần, thì phức tạp và tự nhiên - score orchestra hoặc ambient với nhiều lớp phong phú.`,
    },
    cyberpunk: {
        id: 'cyberpunk',
        name: 'Cyberpunk',
        namePreamble: 'Neon Cyberpunk Future',
        preamble: `Phân cảnh: Tóm tắt một câu về hành động và bối cảnh trong thế giới cyberpunk - tương lai tối, công nghệ xâm lấn.

Hình ảnh: Thế giới đêm thành phố toàn neon - neon màu tím, xanh lam, hồng, vàng rực rỡ. Bóng mạnh, độ tương phản cao, bảng màu bão hòa và lạnh lẽo. Bối cảnh: nhà cao tầng ô uế, quảng cáo hologram, dây điện rối, công nghệ hỏng hóc. Ánh sáng phải có hologram flicker. Nhấn mạnh: "neon glow, cyberpunk dystopia, futuristic tech, bóng mạnh, bảng màu cyber".

Camera: Shot góc cạnh, thường là low-angle hoặc overhead, với framing độc đáo và modern.

Âm thanh: Soundscape synthwave - drone điện tử, beep tech, tiếng máy hỏng hóc, thoại robot hoặc bị distort.

Hiệu ứng âm: Hiệu ứng âm tech-heavy - tiếng scan, tiếng khóa mở điện tử, tiếng máy phục vụ, glitch âm thanh tinh tế.

Nhạc nền: Synthwave hoặc darkwave - synthesizer mạnh mẽ, beat percussive, cảm giác nguy hiểm và năng động.`,
    },
    anime: {
        id: 'anime',
        name: 'Anime',
        namePreamble: 'Japanese Anime Style',
        preamble: `Phân cảnh: Tóm tắt một câu về hành động và bối cảnh với phong cách anime Nhật.

Hình ảnh: Style vẽ anime chuyên nghiệp - línea sạch, cel shading sắc nét, mắt to biểu cảm, hair động. Bảng màu tươi sáng và bão hòa. Bối cảnh có thể là Tokyo hiện đại, công viên anime, nội thất manga hoặc fantasy. Nhấn mạnh: "anime art style, cel shading, vibrant colors, expressive characters, detailed backgrounds".

Camera: Shot kiểu anime - thường dramatic angles, close-up trên biểu cảm khuôn mặt, pan nhanh.

Âm thanh: Soundscape anime - thoại diễn xạ (seiyuu acting style), hiệu ứng âm anime (punch SFX, magical sparkle sfx).

Hiệu ứng âm: Anime SFX - "WHOOSH" tranh động, "SPARKLE" phép thuật, "BANG" chiến đấu, chi tiết nhất về phong cách anime.

Nhạc nền: Anime score - orchestral nhân vật, piano cảm động, electronic upbeat, hoặc J-pop tùy cảnh. Phải có cảm giác anime.`,
    },
    pixar: {
        id: 'pixar',
        name: 'Pixar 3D',
        namePreamble: 'Pixar CGI Animation',
        preamble: `Phân cảnh: Tóm tắt một câu về hành động và bối cảnh với phong cách Pixar.

Hình ảnh: 3D animation kiểu Pixar - nhân vật đáng yêu (cute) hoặc đặc biệt, bối cảnh chi tiết tuyệt đẹp, ánh sáng ấm áp. Mô tả kỹ xảo rendering - texture phong phú, subsurface scattering tự nhiên, global illumination. Bảng màu ấm áp, thường là family-friendly. Nhấn mạnh: "Pixar 3D animation, warm lighting, charming characters, beautiful environment, AAA quality rendering".

Camera: Shot cinematic nhưng vui vẻ - thường wide shots để thấy environment, close-ups trên biểu cảm.

Âm thanh: Soundscape vui vẻ và ấm áp - thoại phù hợp nhân vật (có thể là động vật hoặc vật mô phỏng nhân).

Hiệu ứng âm: Hiệu ứng âm vui, diegetic - tiếng động vật, tiếng nature, hoặc cơ học tùy bối cảnh.

Nhạc nền: Pixar-style score - orchestra ấm áp, piano diễn cảm, có hook melody, tâm trạng vui hoặc xúc động.`,
    },
    stopmotion: {
        id: 'stopmotion',
        name: 'Stop Motion',
        namePreamble: 'Stop Motion Claymation',
        preamble: `Phân cảnh: Tóm tắt một câu về hành động và bối cảnh.

Hình ảnh: Stop motion claymation - nhân vật tạo từ đất sét hoặc polymer, bối cảnh handmade, texture vật liệu thô nhưng có tính thẩm mỹ. Chuyển động nhấp nhô đặc trưng stop motion. Nhấn mạnh: "stop motion, claymation, handmade aesthetic, textured clay, deliberate frame-by-frame motion, film grain".

Camera: Shot thường fixed hoặc slow tracking, studio lighting sáng sạch, shallow DOF để thấy chi tiết tổng thể.

Âm thanh: Soundscape handmade - thoại có pitch funny hoặc cute, hiệu ứng âm stop motion.

Hiệu ứng âm: Hiệu ứng âm handmade chất - tiếng đất sét, tiếng nước, cơ học đơn giản diegetic.

Nhạc nền: Stop motion score - thường quirky, whimsical, piano hoặc folk instruments, tâm trạng cổ tích hoặc vui nhộn.`,
    },
    documentary: {
        id: 'documentary',
        name: 'Tài liệu',
        namePreamble: 'Documentary Realism',
        preamble: `Phân cảnh: Tóm tắt một câu về hành động và bối cảnh với phong cách tài liệu.

Hình ảnh: Style tài liệu chân thực - nhẹ nhàng, natural lighting hoặc minimal intervention, chân dung tự nhiên, bối cảnh thực tế không staging. Có thể có grain film hoặc video noise tự nhiên. Bảng màu trung tính, không bão hòa, chuẩn thực. Nhấn mạnh: "documentary style, natural lighting, authentic, real world, minimal staging, naturalistic color".

Camera: Shot documentary - observational, thường wide shots hoặc medium shots cho bối cảnh, intimate close-ups cho nhân vật. Chuyển động tự nhiên hoặc static.

Âm thanh: Soundscape tự nhiên và tập trung - thoại tự nhiên, bối cảnh âm thực tế.

Hiệu ứng âm: Hiệu ứng âm tối giản, chỉ những gì tự nhiên xuất hiện trong bối cảnh.

Nhạc nền: Thường không có hoặc là ambient tối giản - focus vào lời thoại và âm thanh tự nhiên.`,
    },
    horror: {
        id: 'horror',
        name: 'Kinh dị',
        namePreamble: 'Psychological Horror',
        preamble: `Phân cảnh: Tóm tắt một câu về hành động và bối cảnh tạo cảm giác kinh dị hoặc sợ hãi.

Hình ảnh: Bối cảnh u ám, khủng khiếp, hoặc kỳ lạ - ánh sáng non-diegetic (không tự nhiên), bóng quỷ ám, distorted perspective, unsettling color grading (xanh lam ảo, xám bẩn, đỏ máu). Bối cảnh: phòng tối, nhà hoang, không gian chật hẹp. Nhấn mạnh: "horror atmosphere, eerie lighting, unsettling colors, psychological dread, unnatural perspective".

Camera: Shot aggressive - angles lạ, close-ups khiếp sợ trên biểu cảm, sudden framing changes, fisheye distortion.

Âm thanh: Soundscape kinh dị - thoại lạ, tiếng động vật kỳ dị, silence nặng nề.

Hiệu ứng âm: Hiệu ứng âm kinh dị - tiếng ghost, tiếng kháng cái, tiếng biến dạng, tiếng thì thầm, suspenseful silence.

Nhạc nền: Horror score - strings tremolo, drone deep, stinger sudden, cello buồn, tạo cảm giác tâm lý sợ hãi.`,
    },
    steampunk: {
        id: 'steampunk',
        name: 'Steampunk',
        namePreamble: 'Victorian Steampunk Era',
        preamble: `Phân cảnh: Tóm tắt một câu về hành động và bối cảnh Victorian steampunk.

Hình ảnh: Thế giới steampunk - công nghệ hơi nước cổ điển, cơ khí đồng/thép lộ thiên, bối cảnh Victorian lộn xộn với máy móc. Bảng màu: nâu vàng, đỏ copper, đen, với accumulation của bụi cơ khí. Ánh sáng ấm áp từ ga lamplight và lửa. Nhấn mạnh: "steampunk aesthetic, Victorian machinery, brass and copper, industrial gears, vintage technology, warm gaslight".

Camera: Shot cinematic - thường medium shots để showcase máy móc, low-angle để tạo grandeur cơ khí.

Âm thanh: Soundscape mechanical - tiếng cơ khí, tiếng hơi nước, thoại Victorian era.

Hiệu ứng âm: Hiệu ứng âm mechanical diegetic - tiếng bánh răng quay, hơi nước thít, chuông, chuyển động cơ khí.

Nhạc nền: Steampunk score - orchestral Victorian, mechanical percussion, violin, brass, cảm giác adventure và retro-futurism.`,
    },
    fantasy: {
        id: 'fantasy',
        name: 'Fantasy',
        namePreamble: 'Epic Fantasy Realism',
        preamble: `Phân cảnh: Tóm tắt một câu về hành động và bối cảnh fantasy epic.

Hình ảnh: Thế giới fantasy - architecture kỳ bí, thiên nhiên huyền diệu (rừng ma phương, núi huyền ảo), phép thuật hiển thị qua hiệu ứng ánh sáng (aura phát sáng, sparkle ma phương). Bảng màu phong phú - xanh lá đậm, tím ma phương, vàng vàng. Ánh sáng có thể siêu tự nhiên. Nhấn mạnh: "fantasy epic, magical world, mystical lighting, enchanted landscapes, detailed fantasy architecture".

Camera: Shot cinematic - thường wide shots để showcase fantasy landscape, dramatic angles cho hành động ma phương.

Âm thanh: Soundscape fantasy - thoại nhân vật fantasy, tiếng ma phương, ambient huyền diệu.

Hiệu ứng âm: Hiệu ứng âm ma phương - tiếng ma phương cast, tiếng fairy, tiếng thiên nhiên huyền diệu, ambient atmospheric.

Nhạc nền: Fantasy score - orchestral epic, harp sparkle, flute tự nhiên, choir ethereal, tâm trạng phép thuật và adventure.`,
    },
    sondau: {
        id: 'sondau',
        name: 'Sơn dầu',
        namePreamble: 'Classical Oil Painting',
        preamble: `Phân cảnh: Tóm tắt một câu về hành động và bối cảnh.

Hình ảnh: Cảnh được trình bày như một bức tranh sơn dầu cổ điển - brush strokes rõ ràng, texture canvas, sắc thái màu ấm áp hoặc lạnh tùy chủ đề. Các chi tiết mềm mại, không quá sharp. Bảng màu giả cổ - có thể sepia tone hoặc palette riêng (Rembrandt, Caravaggio style). Nhấn mạnh: "oil painting, classical art style, visible brush strokes, canvas texture, old master painting aesthetic".

Camera: Shot thường là tĩnh hoặc khảnh từ từ - như đang ngắm tranh trong viện bảo tàng.

Âm thanh: Soundscape tối giản - thường là ambient classical violin hoặc silence tĩnh lặng.

Hiệu ứng âm: Thường không có - hoặc ambient vĩ cô đơn (VD: tiếng xoạc vệt sơn).

Nhạc nền: Classical score - piano solo, orchestral chamber, baroque, tâm trạng tĩnh lặng và suy tư.`,
    },
    chinh_sua: {
        id: 'chinh_sua',
        name: 'Chỉnh sửa',
        namePreamble: 'Custom Edit Style',
        preamble: `Phân cảnh: Tóm tắt một câu về hành động và bối cảnh.

Hình ảnh: [Cho phép user tùy chỉnh] - mô tả chi tiết chủ thể, bối cảnh, kiểu ánh sáng, bảng màu, và thẩm mỹ tổng thể.

Camera: [Cho phép user tùy chỉnh] - chỉ định kiểu shot, góc quay, và chuyển động.

Âm thanh: [Cho phép user tùy chỉnh] - chi tiết soundscape, bao gồm thoại, âm hưởng, ambient.

Hiệu ứng âm: [Cho phép user tùy chỉnh] - các hiệu ứng âm diegetic cụ thể.

Nhạc nền: [Cho phép user tùy chỉnh] - phong cách và tâm trạng của nhạc nền, hoặc "Không có" nếu không cần.`,
    },
};
export default StyleConfigService;
