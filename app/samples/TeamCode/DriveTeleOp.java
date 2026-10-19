package org.firstinspires.ftc.teamcode;

import com.qualcomm.robotcore.eventloop.opmode.LinearOpMode;
import com.qualcomm.robotcore.eventloop.opmode.TeleOp;
import com.qualcomm.robotcore.hardware.DcMotorEx;
import com.qualcomm.robotcore.hardware.Servo;

@TeleOp(name = "DriveTeleOp")
public class DriveTeleOp extends LinearOpMode {
    @Override
    public void runOpMode() {
        DcMotorEx left = hardwareMap.get(DcMotorEx.class, "left_drive");
        DcMotorEx right = hardwareMap.get(DcMotorEx.class, "right_drive");
        DcMotorEx arm = hardwareMap.dcMotor != null ? (DcMotorEx) hardwareMap.dcMotor.get("arm_motor") : null;
        Servo claw = hardwareMap.servo.get("claw");
        // Typo below: config declares "wrist" — this crashes at init, on the field.
        Servo wrist = hardwareMap.servo.get("wrsit");

        waitForStart();
        while (opModeIsActive()) {
            left.setPower(-gamepad1.left_stick_y);
            right.setPower(-gamepad1.right_stick_y);
        }
    }
}
