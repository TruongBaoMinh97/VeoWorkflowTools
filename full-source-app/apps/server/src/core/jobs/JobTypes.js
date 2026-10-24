/**
 * Job types registered with SQLiteQueueManager.
 */
export var JobType;
(function (JobType) {
    JobType["GEN_NORMAL"] = "gen-normal";
    JobType["VIDEO_UPSAMPLING"] = "video-upsampling";
    JobType["IMAGE_UPSAMPLING"] = "image-upsampling";
})(JobType || (JobType = {}));
