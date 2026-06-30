# Generated for DONATION_NEEDS_REVIEW (stranded-donation resolver, Step 3).

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('notifications', '0003_alter_notification_notification_type'),
    ]

    operations = [
        migrations.AlterField(
            model_name='notification',
            name='notification_type',
            field=models.CharField(choices=[('DONATION_RECEIVED', 'Donation Received'), ('DONATION_NEEDS_REVIEW', 'Donation Needs Review'), ('DISBURSEMENT_SUBMITTED', 'Disbursement Submitted'), ('DISBURSEMENT_APPROVED', 'Disbursement Approved'), ('DISBURSEMENT_REJECTED', 'Disbursement Rejected'), ('DISBURSEMENT_PAID', 'Disbursement Paid'), ('DISBURSEMENT_FAILED', 'Disbursement Failed'), ('RECONCILIATION_PAYMENT_CONFIRMED', 'Reconciliation Payment Confirmed'), ('SUBSCRIPTION_REMINDER', 'Subscription Reminder'), ('SUBSCRIPTION_LAPSED', 'Subscription Lapsed'), ('CAMPAIGN_DESTINATION_CHANGED', 'Campaign Destination Changed')], max_length=40),
        ),
    ]
